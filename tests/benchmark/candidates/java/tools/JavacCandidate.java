// Candidate: javac, the official Java compiler, through its own API (javax.tools and the Compiler
// Tree API, com.sun.source). Every file is parsed and attributed in one compilation; each call's
// answer is the element javac attributed to it (Trees.getElement), and its place is the tree javac
// holds for that element (Trees.getPath). An element with no tree in the compilation is outside.
//
// Usage: java JavacCandidate <root> <file-list> <classpath or ""> <out.jsonl>
import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
import javax.tools.*;

public final class JavacCandidate {
  public static void main(String[] args) throws Exception {
    long t0 = System.nanoTime();
    Path root = Paths.get(args[0]).toAbsolutePath().normalize();
    List<String> rel = Out.files(Paths.get(args[1]));
    String cp = args[2];
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
    StandardJavaFileManager fm = compiler.getStandardFileManager(diags, Locale.ROOT, StandardCharsets.UTF_8);
    List<Path> paths = new ArrayList<>();
    for (String r : rel) paths.add(root.resolve(r));
    Iterable<? extends JavaFileObject> units = fm.getJavaFileObjectsFromPaths(paths);
    List<String> opts = new ArrayList<>(List.of("-proc:none", "-nowarn", "-Xlint:none", "-encoding", "UTF-8", "-Xmaxerrs", "1000000",
        // Attribute every class even when some have errors, as an indexer must (javac's default stops after the first failing phase).
        "-XDshould-stop.ifError=FLOW"));
    if (!cp.isEmpty()) opts.addAll(List.of("-cp", cp));
    JavacTask task = (JavacTask) compiler.getTask(null, fm, diags, opts, null, units);
    Iterable<? extends CompilationUnitTree> cus = task.parse();
    long t1 = System.nanoTime();
    task.analyze();
    long t2 = System.nanoTime();
    Trees trees = Trees.instance(task);
    SourcePositions sp = trees.getSourcePositions();
    try (Out out = new Out(Paths.get(args[3]))) {
      Map<CompilationUnitTree, int[]> starts = new HashMap<>();
      Map<CompilationUnitTree, String> texts = new HashMap<>();
      java.util.function.Function<CompilationUnitTree, String> textOf = cu -> texts.computeIfAbsent(cu, c -> {
        try {
          return c.getSourceFile().getCharContent(true).toString();
        } catch (java.io.IOException e) {
          throw new RuntimeException(e);
        }
      });
      java.util.function.Function<CompilationUnitTree, int[]> startsOf = cu -> starts.computeIfAbsent(cu, c -> {
        try {
          return Out.lineStarts(c.getSourceFile().getCharContent(true).toString());
        } catch (java.io.IOException e) {
          throw new RuntimeException(e);
        }
      });
      java.util.function.Function<CompilationUnitTree, String> relOf = cu -> root.relativize(Paths.get(cu.getSourceFile().toUri()).normalize()).toString();
      int calls = 0;
      for (CompilationUnitTree cu : cus) {
        String file = relOf.apply(cu);
        int[] ls = startsOf.apply(cu);
        new TreePathScanner<Void, Void>() {
          @Override
          public Void visitMethod(MethodTree t, Void v) {
            long s = sp.getStartPosition(cu, t), e = sp.getEndPosition(cu, t);
            if (e >= 0) out.fn(file, nameOf(t, getCurrentPath()), t.getName().contentEquals("<init>") ? "constructor" : "method", Out.lineOf(ls, (int) s), Out.lineOf(ls, (int) e - 1));
            return super.visitMethod(t, v);
          }

          @Override
          public Void visitLambdaExpression(LambdaExpressionTree t, Void v) {
            out.fn(file, "", "lambda", Out.lineOf(ls, (int) sp.getStartPosition(cu, t)), Out.lineOf(ls, (int) sp.getEndPosition(cu, t) - 1));
            return super.visitLambdaExpression(t, v);
          }

          @Override
          public Void visitMethodInvocation(MethodInvocationTree t, Void v) {
            int[] at = namePos(cu, sp, t.getMethodSelect());
            String name = nameOfSelect(t.getMethodSelect());
            answer(file, ls, at[0], name, unproven(t.getArguments()) ? null : trees.getElement(getCurrentPath()));
            return super.visitMethodInvocation(t, v);
          }

          @Override
          public Void visitNewClass(NewClassTree t, Void v) {
            Tree id = typeName(t.getIdentifier());
            int[] at = namePos(cu, sp, id);
            Element e = unproven(t.getArguments()) ? null : trees.getElement(getCurrentPath());
            if (e != null && t.getClassBody() != null) e = superConstructor(new TreePath(getCurrentPath(), t.getClassBody()), t.getClassBody(), e);
            answer(file, ls, at[0], nameOfSelect(id), e);
            return super.visitNewClass(t, v);
          }

          // Overload resolution chooses by the arguments' types (JLS 15.12.2). When javac could not
          // type an argument, it still picks a method to go on with; that pick is no proof.
          boolean unproven(List<? extends ExpressionTree> args) {
            for (ExpressionTree a : args) {
              TypeMirror tm = trees.getTypeMirror(new TreePath(getCurrentPath(), a));
              if (tm == null || erroneous(tm)) return true;
            }
            return false;
          }

          // A class body made by `new T() {...}` runs T's constructor (JLS 15.9.5.1): javac writes that
          // call as `super(...)` in the anonymous class's constructor, so its element is the answer.
          Element superConstructor(TreePath body, ClassTree cls, Element fallback) {
            for (Tree m : cls.getMembers()) {
              if (!(m instanceof MethodTree mt) || !mt.getName().contentEquals("<init>") || mt.getBody() == null) continue;
              TreePath mp = new TreePath(new TreePath(body, mt), mt.getBody());
              for (StatementTree st : mt.getBody().getStatements())
                if (st instanceof ExpressionStatementTree es && es.getExpression() instanceof MethodInvocationTree mi
                    && mi.getMethodSelect() instanceof IdentifierTree id && id.getName().contentEquals("super"))
                  return trees.getElement(new TreePath(new TreePath(mp, st), mi));
            }
            return fallback;
          }

          void answer(String file, int[] ls, int pos, String name, Element e) {
            // A call javac adds itself, such as the `super()` it puts in a constructor (JLS 8.8.7), is not written in the file.
            if (pos < 0 || !textOf.apply(cu).startsWith(name, pos)) return;
            int line = Out.lineOf(ls, pos);
            if (!(e instanceof ExecutableElement) || e.asType().getKind() == TypeKind.ERROR) {
              out.call(file, pos, line, name, "unknown", List.of(), e == null ? "no element or an untyped argument" : "error element");
              return;
            }
            Element type = e.getEnclosingElement();
            if (type == null || type.asType().getKind() == TypeKind.ERROR) {
              out.call(file, pos, line, name, "unknown", List.of(), "error owner");
              return;
            }
            String dname = e.getKind() == ElementKind.CONSTRUCTOR ? type.getSimpleName().toString() : e.getSimpleName().toString();
            TreePath p = trees.getPath(e);
            if (p != null && p.getLeaf() instanceof MethodTree && sp.getEndPosition(p.getCompilationUnit(), p.getLeaf()) >= 0) {
              out.call(file, pos, line, name, "repo", List.of(place(p, dname)), null);
              return;
            }
            // No tree of its own: a member the language declares implicitly (JLS 8.8.9, 8.9.3, 8.10.3)
            // is placed at its type when the type is in the compilation; else it was read from a class file.
            TreePath tp = trees.getPath(type);
            if (tp != null) out.call(file, pos, line, name, "repo", List.of(place(tp, dname)), "implicit");
            else out.call(file, pos, line, name, "outside", List.of(), null);
          }

          Out.Decl place(TreePath p, String name) {
            CompilationUnitTree dcu = p.getCompilationUnit();
            int[] dls = startsOf.apply(dcu);
            long s = sp.getStartPosition(dcu, p.getLeaf()), e = sp.getEndPosition(dcu, p.getLeaf());
            return new Out.Decl(relOf.apply(dcu), name, Out.lineOf(dls, (int) s), Out.lineOf(dls, (int) Math.max(s, e - 1)));
          }
        }.scan(cu, null);
      }
      long t3 = System.nanoTime();
      long errors = diags.getDiagnostics().stream().filter(d -> d.getKind() == Diagnostic.Kind.ERROR).count();
      out.info("tool", "javac " + System.getProperty("java.version"));
      out.info("errors", Long.toString(errors));
      diags.getDiagnostics().stream().filter(d -> d.getKind() == Diagnostic.Kind.ERROR).limit(5)
          .forEach(d -> out.info("error", d.getSource() == null ? d.getMessage(Locale.ROOT) : d.getSource().getName() + ":" + d.getLineNumber() + " " + d.getMessage(Locale.ROOT)));
      out.info("parseMs", Long.toString((t1 - t0) / 1_000_000));
      out.info("analyzeMs", Long.toString((t2 - t1) / 1_000_000));
      out.info("answerMs", Long.toString((t3 - t2) / 1_000_000));
    }
  }

  /** A type javac could not work out, or one built from such a type. */
  static boolean erroneous(TypeMirror t) {
    if (t.getKind() == TypeKind.ERROR) return true;
    if (t instanceof javax.lang.model.type.ArrayType a) return erroneous(a.getComponentType());
    if (t instanceof javax.lang.model.type.DeclaredType d) {
      for (TypeMirror x : d.getTypeArguments()) if (erroneous(x)) return true;
      return d.getEnclosingType().getKind() != TypeKind.NONE && erroneous(d.getEnclosingType());
    }
    if (t instanceof javax.lang.model.type.WildcardType w)
      return w.getExtendsBound() != null && erroneous(w.getExtendsBound()) || w.getSuperBound() != null && erroneous(w.getSuperBound());
    return false;
  }

  static String nameOf(MethodTree t, TreePath path) {
    if (!t.getName().contentEquals("<init>")) return t.getName().toString();
    for (TreePath p = path.getParentPath(); p != null; p = p.getParentPath())
      if (p.getLeaf() instanceof ClassTree c) return c.getSimpleName().toString();
    return "";
  }

  /** The tree that names a type, without its type arguments or annotations. */
  static Tree typeName(Tree t) {
    while (true) {
      if (t instanceof ParameterizedTypeTree p) t = p.getType();
      else if (t instanceof AnnotatedTypeTree a) t = a.getUnderlyingType();
      else return t;
    }
  }

  static String nameOfSelect(Tree t) {
    if (t instanceof IdentifierTree i) return i.getName().toString();
    if (t instanceof MemberSelectTree m) return m.getIdentifier().toString();
    return "";
  }

  /** Where the called name is written: an identifier's start, or the end of a selection less its name. */
  static int[] namePos(CompilationUnitTree cu, SourcePositions sp, Tree t) {
    if (t instanceof MemberSelectTree m) return new int[] {(int) sp.getEndPosition(cu, m) - m.getIdentifier().length()};
    return new int[] {(int) sp.getStartPosition(cu, t)};
  }
}
