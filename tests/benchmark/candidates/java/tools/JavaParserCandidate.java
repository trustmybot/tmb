// Candidate: JavaParser with its symbol solver (javaparser-symbol-solver-core), an independent open
// source Java front end with its own type resolution. Types are looked up in the JDK the tool runs
// on (ReflectionTypeSolver), in the source roots of the files read, and in the classpath's jars.
// Each call's answer is what resolve() gives; its place is the declaration's own syntax node when
// the declaration comes from a source file, and otherwise the call goes outside.
//
// Usage: java JavaParserCandidate <root> <file-list> <classpath or ""> <out.jsonl>
import com.github.javaparser.*;
import com.github.javaparser.ast.*;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.nodeTypes.NodeWithSimpleName;
import com.github.javaparser.ast.stmt.ExplicitConstructorInvocationStmt;
import com.github.javaparser.resolution.declarations.*;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.*;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public final class JavaParserCandidate {
  public static void main(String[] args) throws Exception {
    long t0 = System.nanoTime();
    Path root = Paths.get(args[0]).toAbsolutePath().normalize();
    List<String> rel = Out.files(Paths.get(args[1]));
    String cp = args[2];

    // A file's source root is its folder less the folders its package names (JLS 7.2).
    ParserConfiguration plain = new ParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21).setTabSize(1);
    Set<Path> roots = new LinkedHashSet<>();
    for (String r : rel) {
      Path f = root.resolve(r);
      var res = new JavaParser(plain).parse(f);
      Path dir = f.getParent();
      if (res.getResult().isPresent()) {
        var pkg = res.getResult().get().getPackageDeclaration();
        if (pkg.isPresent()) for (int i = 0; i < pkg.get().getName().asString().split("\\.").length; i++) dir = dir.getParent();
      }
      roots.add(dir);
    }
    CombinedTypeSolver solver = new CombinedTypeSolver(new ReflectionTypeSolver(true));
    for (Path r : roots) solver.add(new JavaParserTypeSolver(r, plain));
    if (!cp.isEmpty()) for (String jar : cp.split(File.pathSeparator)) if (jar.endsWith(".jar")) solver.add(new JarTypeSolver(jar));
    ParserConfiguration cfg = new ParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21).setTabSize(1)
        .setSymbolResolver(new JavaSymbolSolver(solver));
    JavaParser parser = new JavaParser(cfg);
    int errors = 0;
    long t1 = System.nanoTime();
    try (Out out = new Out(Paths.get(args[3]))) {
      for (String file : rel) {
        Path f = root.resolve(file);
        String text = Files.readString(f, StandardCharsets.UTF_8);
        int[] ls = Out.lineStarts(text);
        var res = parser.parse(f);
        errors += res.getProblems().size();
        if (res.getResult().isEmpty()) continue;
        CompilationUnit cu = res.getResult().get();
        java.util.function.Function<Position, Integer> off = p -> ls[p.line - 1] + p.column - 1;
        for (CallableDeclaration<?> d : cu.findAll(CallableDeclaration.class)) {
          Out.Decl p = place(d, ls, file, d.getNameAsString());
          if (p != null) out.fn(file, p.name(), d instanceof ConstructorDeclaration ? "constructor" : "method", p.start(), p.end());
        }
        for (AnnotationMemberDeclaration d : cu.findAll(AnnotationMemberDeclaration.class)) {
          Out.Decl p = place(d, ls, file, d.getNameAsString());
          if (p != null) out.fn(file, p.name(), "method", p.start(), p.end());
        }
        for (CompactConstructorDeclaration d : cu.findAll(CompactConstructorDeclaration.class)) {
          Out.Decl p = place(d, ls, file, d.getNameAsString());
          if (p != null) out.fn(file, p.name(), "constructor", p.start(), p.end());
        }
        for (LambdaExpr d : cu.findAll(LambdaExpr.class))
          d.getRange().ifPresent(r -> out.fn(file, "", "lambda", r.begin.line, r.end.line));
        for (MethodCallExpr n : cu.findAll(MethodCallExpr.class)) {
          int pos = off.apply(n.getName().getBegin().get());
          answer(out, file, ls, text, pos, n.getNameAsString(), () -> n.resolve(), root);
        }
        for (ObjectCreationExpr n : cu.findAll(ObjectCreationExpr.class)) {
          int pos = off.apply(n.getType().getName().getBegin().get());
          answer(out, file, ls, text, pos, n.getType().getNameAsString(), () -> n.resolve(), root);
        }
        for (ExplicitConstructorInvocationStmt n : cu.findAll(ExplicitConstructorInvocationStmt.class)) {
          String kw = n.isThis() ? "this" : "super";
          int from = n.getExpression().flatMap(Node::getEnd).map(p -> off.apply(p) + 1).orElse(off.apply(n.getBegin().get()));
          answer(out, file, ls, text, text.indexOf(kw, from), kw, () -> n.resolve(), root);
        }
      }
      long t2 = System.nanoTime();
      out.info("tool", new File(JavaParser.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getName());
      out.info("errors", Integer.toString(errors));
      out.info("rootsMs", Long.toString((t1 - t0) / 1_000_000));
      out.info("analyzeMs", Long.toString((t2 - t1) / 1_000_000));
    }
  }

  interface Resolve {
    ResolvedDeclaration get();
  }

  static Out.Decl place(Node d, int[] ls, String file, String name) {
    if (d.getRange().isEmpty()) return null;
    // A declaration starts at its first modifier or annotation; JavaParser's range leaves out the Javadoc already.
    return new Out.Decl(file, name, d.getRange().get().begin.line, d.getRange().get().end.line);
  }

  static void answer(Out out, String file, int[] ls, String text, int pos, String name, Resolve r, Path root) {
    if (pos < 0 || !text.startsWith(name, pos)) return;
    int line = Out.lineOf(ls, pos);
    ResolvedDeclaration d;
    try {
      d = r.get();
    } catch (Throwable e) {
      out.call(file, pos, line, name, "unknown", List.of(), e.getClass().getSimpleName());
      return;
    }
    Optional<Node> ast = d.toAst();
    if (ast.isPresent() && ast.get() instanceof CallableDeclaration<?> || ast.isPresent() && ast.get() instanceof AnnotationMemberDeclaration
        || ast.isPresent() && ast.get() instanceof CompactConstructorDeclaration) {
      Node n = ast.get();
      Optional<Path> p = n.findCompilationUnit().flatMap(CompilationUnit::getStorage).map(CompilationUnit.Storage::getPath);
      if (p.isEmpty()) {
        out.call(file, pos, line, name, "unknown", List.of(), "no storage");
        return;
      }
      String dname = n instanceof ConstructorDeclaration || n instanceof CompactConstructorDeclaration
          ? ((ResolvedMethodLikeDeclaration) d).declaringType().getName()
          : ((NodeWithSimpleName<?>) n).getNameAsString();
      out.call(file, pos, line, name, "repo", List.of(new Out.Decl(root.relativize(p.get().toAbsolutePath().normalize()).toString(), dname, n.getRange().get().begin.line, n.getRange().get().end.line)), null);
      return;
    }
    if (d instanceof ResolvedMethodLikeDeclaration m) {
      // No syntax node of its own: a member the language declares implicitly (JLS 8.8.9, 8.9.3, 8.10.3) is placed at its type.
      ResolvedReferenceTypeDeclaration t = m.declaringType();
      Optional<Node> tn = t.toAst();
      if (tn.isPresent()) {
        Node n = tn.get();
        Optional<Path> p = n.findCompilationUnit().flatMap(CompilationUnit::getStorage).map(CompilationUnit.Storage::getPath);
        String dname = m instanceof ResolvedConstructorDeclaration ? t.getName() : m.getName();
        if (p.isPresent() && n.getRange().isPresent()) {
          out.call(file, pos, line, name, "repo", List.of(new Out.Decl(root.relativize(p.get().toAbsolutePath().normalize()).toString(), dname, n.getRange().get().begin.line, n.getRange().get().end.line)), "implicit");
          return;
        }
        out.call(file, pos, line, name, "unknown", List.of(), "source type with no place");
        return;
      }
      out.call(file, pos, line, name, "outside", List.of(), null);
      return;
    }
    out.call(file, pos, line, name, "unknown", List.of(), "not a callable");
  }
}
