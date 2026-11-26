// Candidate: Eclipse JDT Core, the Eclipse Java compiler (ECJ) behind its DOM API, standalone (no
// workspace). Every file is parsed with bindings in one batch (ASTParser.createASTs). Each call's
// answer is the method binding the compiler resolved; its place is the declaration in the batch
// whose binding key is the same. A binding with no declaration in the batch is outside.
//
// Usage: java JdtCandidate <root> <file-list> <classpath or ""> <out.jsonl>
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.dom.*;

public final class JdtCandidate {
  record Call(String file, int pos, int line, String name, IMethodBinding b) {}

  public static void main(String[] args) throws Exception {
    long t0 = System.nanoTime();
    Path root = Paths.get(args[0]).toAbsolutePath().normalize();
    List<String> rel = Out.files(Paths.get(args[1]));
    String[] cp = args[2].isEmpty() ? new String[0] : args[2].split(File.pathSeparator);
    ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
    parser.setKind(ASTParser.K_COMPILATION_UNIT);
    parser.setResolveBindings(true);
    parser.setBindingsRecovery(true);
    parser.setStatementsRecovery(true);
    Map<String, String> opts = JavaCore.getOptions();
    JavaCore.setComplianceOptions(JavaCore.VERSION_21, opts);
    parser.setCompilerOptions(opts);
    parser.setEnvironment(cp, new String[0], new String[0], true);
    String[] paths = rel.stream().map(r -> root.resolve(r).toString()).toArray(String[]::new);
    String[] enc = new String[paths.length];
    Arrays.fill(enc, StandardCharsets.UTF_8.name());

    Map<String, Out.Decl> decls = new HashMap<>();
    Map<String, Out.Decl> types = new HashMap<>();
    List<Call> calls = new ArrayList<>();
    int[] problems = {0};
    try (Out out = new Out(Paths.get(args[3]))) {
      parser.createASTs(paths, enc, new String[0], new FileASTRequestor() {
        @Override
        public void acceptAST(String sourceFilePath, CompilationUnit cu) {
          String file = root.relativize(Paths.get(sourceFilePath).normalize()).toString();
          String text;
          try {
            text = Files.readString(Paths.get(sourceFilePath), StandardCharsets.UTF_8);
          } catch (java.io.IOException e) {
            throw new RuntimeException(e);
          }
          for (var p : cu.getProblems()) if (p.isError()) problems[0]++;
          cu.accept(new ASTVisitor() {
            int line(int pos) {
              return cu.getLineNumber(pos);
            }

            Out.Decl place(ASTNode n, int start, String name) {
              return new Out.Decl(file, name, line(start), line(n.getStartPosition() + n.getLength() - 1));
            }

            /** A declaration starts at its first modifier or annotation, not at its Javadoc. */
            int startOf(BodyDeclaration d, ASTNode name) {
              if (d.getJavadoc() == null) return d.getStartPosition();
              int s = name.getStartPosition();
              for (Object m : d.modifiers()) s = Math.min(s, ((ASTNode) m).getStartPosition());
              if (d instanceof MethodDeclaration md) {
                for (Object tp : md.typeParameters()) s = Math.min(s, ((ASTNode) tp).getStartPosition());
                if (md.getReturnType2() != null) s = Math.min(s, md.getReturnType2().getStartPosition());
              }
              return s;
            }

            void type(AbstractTypeDeclaration d) {
              ITypeBinding b = d.resolveBinding();
              if (b != null) types.put(b.getKey(), place(d, startOf(d, d.getName()), d.getName().getIdentifier()));
            }

            @Override
            public boolean visit(TypeDeclaration d) {
              type(d);
              return true;
            }

            @Override
            public boolean visit(EnumDeclaration d) {
              type(d);
              return true;
            }

            @Override
            public boolean visit(RecordDeclaration d) {
              type(d);
              return true;
            }

            @Override
            public boolean visit(AnnotationTypeDeclaration d) {
              type(d);
              return true;
            }

            @Override
            public boolean visit(MethodDeclaration d) {
              int s = startOf(d, d.getName());
              Out.Decl p = place(d, s, d.getName().getIdentifier());
              out.fn(file, p.name(), d.isConstructor() ? "constructor" : "method", p.start(), p.end());
              IMethodBinding b = d.resolveBinding();
              if (b != null) decls.put(b.getKey(), p);
              return true;
            }

            @Override
            public boolean visit(AnnotationTypeMemberDeclaration d) {
              Out.Decl p = place(d, startOf(d, d.getName()), d.getName().getIdentifier());
              out.fn(file, p.name(), "method", p.start(), p.end());
              IMethodBinding b = d.resolveBinding();
              if (b != null) decls.put(b.getKey(), p);
              return true;
            }

            @Override
            public boolean visit(LambdaExpression d) {
              out.fn(file, "", "lambda", line(d.getStartPosition()), line(d.getStartPosition() + d.getLength() - 1));
              return true;
            }

            void call(int pos, String name, IMethodBinding b) {
              if (pos < 0 || !text.startsWith(name, pos)) return;
              calls.add(new Call(file, pos, line(pos), name, b));
            }

            @Override
            public boolean visit(MethodInvocation n) {
              call(n.getName().getStartPosition(), n.getName().getIdentifier(), n.resolveMethodBinding());
              return true;
            }

            @Override
            public boolean visit(SuperMethodInvocation n) {
              call(n.getName().getStartPosition(), n.getName().getIdentifier(), n.resolveMethodBinding());
              return true;
            }

            @Override
            public boolean visit(ClassInstanceCreation n) {
              SimpleName id = simpleName(n.getType());
              if (id != null) call(id.getStartPosition(), id.getIdentifier(), n.resolveConstructorBinding());
              return true;
            }

            @Override
            public boolean visit(ConstructorInvocation n) {
              call(text.indexOf("this", n.getStartPosition()), "this", n.resolveConstructorBinding());
              return true;
            }

            @Override
            public boolean visit(SuperConstructorInvocation n) {
              int from = n.getExpression() == null ? n.getStartPosition() : n.getExpression().getStartPosition() + n.getExpression().getLength();
              call(text.indexOf("super", from), "super", n.resolveConstructorBinding());
              return true;
            }
          });
        }
      }, null);
      long t1 = System.nanoTime();
      for (Call c : calls) answer(out, c, decls, types);
      long t2 = System.nanoTime();
      out.info("tool", new File(JavaCore.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getName());
      out.info("errors", Integer.toString(problems[0]));
      out.info("analyzeMs", Long.toString((t1 - t0) / 1_000_000));
      out.info("answerMs", Long.toString((t2 - t1) / 1_000_000));
    }
  }

  static void answer(Out out, Call c, Map<String, Out.Decl> decls, Map<String, Out.Decl> types) {
    IMethodBinding b = c.b();
    if (b == null || b.isRecovered()) {
      out.call(c.file(), c.pos(), c.line(), c.name(), "unknown", List.of(), b == null ? "no binding" : "recovered binding");
      return;
    }
    // A class body made by `new T() {...}` runs T's constructor (JLS 15.9.5.1).
    ITypeBinding owner = b.getDeclaringClass();
    if (owner != null && owner.isAnonymous() && b.isConstructor()) {
      IMethodBinding sup = superConstructor(owner, b);
      if (sup == null) {
        out.call(c.file(), c.pos(), c.line(), c.name(), "unknown", List.of(), "anonymous constructor");
        return;
      }
      b = sup;
      owner = b.getDeclaringClass();
    }
    if (owner == null || owner.isRecovered()) {
      out.call(c.file(), c.pos(), c.line(), c.name(), "unknown", List.of(), "recovered owner");
      return;
    }
    IMethodBinding decl = b.getMethodDeclaration();
    Out.Decl d = decls.get(decl.getKey());
    String dname = decl.isConstructor() ? owner.getErasure().getName() : decl.getName();
    if (d != null) out.call(c.file(), c.pos(), c.line(), c.name(), "repo", List.of(d), null);
    else if (owner.isFromSource()) {
      // A member the language declares implicitly (JLS 8.8.9, 8.9.3, 8.10.3) is placed at its type.
      Out.Decl t = types.get(owner.getErasure().getKey());
      if (t != null) out.call(c.file(), c.pos(), c.line(), c.name(), "repo", List.of(new Out.Decl(t.file(), dname, t.start(), t.end())), "implicit");
      else out.call(c.file(), c.pos(), c.line(), c.name(), "unknown", List.of(), "source type not in the batch");
    } else out.call(c.file(), c.pos(), c.line(), c.name(), "outside", List.of(), null);
  }

  /** The superclass constructor an anonymous class's constructor runs: the one whose parameters it takes. */
  static IMethodBinding superConstructor(ITypeBinding anon, IMethodBinding anonCtor) {
    ITypeBinding sup = anon.getSuperclass();
    if (sup == null) return null;
    if (anon.getInterfaces().length > 0 && "java.lang.Object".equals(sup.getQualifiedName())) {
      for (IMethodBinding m : sup.getDeclaredMethods()) if (m.isConstructor() && m.getParameterTypes().length == 0) return m;
      return null;
    }
    IMethodBinding found = null;
    for (IMethodBinding m : sup.getDeclaredMethods()) {
      if (!m.isConstructor() || !Arrays.equals(erasures(m.getParameterTypes()), erasures(anonCtor.getParameterTypes()))) continue;
      if (found != null) return null;
      found = m;
    }
    return found;
  }

  static String[] erasures(ITypeBinding[] ts) {
    String[] out = new String[ts.length];
    for (int i = 0; i < ts.length; i++) out[i] = ts[i].getErasure().getKey();
    return out;
  }

  static SimpleName simpleName(Type t) {
    if (t instanceof ParameterizedType p) return simpleName(p.getType());
    if (t instanceof SimpleType s) return s.getName() instanceof QualifiedName q ? q.getName() : (SimpleName) s.getName();
    if (t instanceof QualifiedType q) return q.getName();
    if (t instanceof NameQualifiedType q) return q.getName();
    return null;
  }
}
