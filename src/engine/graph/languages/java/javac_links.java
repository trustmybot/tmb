// Way B for Java (trustmybot/tmb#353): the adapter tmb carries, run by the user's own `java` in its
// source-file mode. It asks javac, through the JDK's compiler API (javax.tools and com.sun.source),
// which declaration each call of the repo names; it does not imitate javac. It uses only the JDK.
//
// Usage: java javac_links.java <folder> <empty folder>. It reads every .java file under the folder
// and writes:
//
//   {"java": "21.0.1", "errors": n, "firstErrors": ["file:line: message", ...],
//    "calls": [{"file", "pos", "line", "name", "callee", "answer"}]}
//
// "callee" is how the call is written: "name" (`m()`), "qualified" (`x.m()`, `T.m()`), "creation"
// (`new C()`), or "this" or "super" (`this(…)`, `super(…)`). "answer" is one of:
//   {"repo": {"file", "name", "start", "end"}}  a declaration in the repo: its file, its simple name,
//                                               and its first and last lines; a construction's is
//                                               the class
//   {"outside": "java.lang.Math.max"}           a declaration javac reads from outside the repo
//   {"notKnown": "why"}                         no answer
//
// How javac is run (javac's documented options):
// - Annotation processing is off (-proc:none): no code of the repo, or of anyone else, runs.
// - The class path is the empty folder: no build tool lays out the repo's dependencies, and nothing
//   is downloaded, so a call into a library is not known.
// - The source path is the repo's source roots, each found from a file's package declaration and
//   its path (JLS 7.4.1): the folder that holds the package's folders.
// - A module declaration (module-info.java, JLS 7.7) is left out, by tool.ts, which does not write
//   it to the folder, and here, so every file is read in the unnamed module, which reads every
//   module of the JDK (JLS 7.7.5).
// - The language level is the JDK's own default: no --release is given.
//
// A call is not known when javac's answer rests on an error, since javac answers on with what it
// has (JLS 15.12, "An answer given on an error is no answer" in CODE_GRAPH.md):
// - javac reports an error at the call;
// - an argument's type, or a parameter's type of the method it chooses, is one javac cannot find:
//   the overload it chooses is not proven (15.12.2);
// - a type that is searched for the method has a supertype javac cannot find, which may declare
//   the method or an overload of it: the type of the expression before the dot, or, for a simple
//   name, each class around the call out to the one the method is a member of (15.12.1);
// - a simple name of a type the file imports from where javac cannot find it, when javac finds
//   another type of that name instead (6.4.1): every call in that file, since that type may be any
//   value's;
// - a method found through a static import, in a file with a static import javac cannot find,
//   which may import an overload of it (6.4.1, 15.12.1);
// - two files declare the same class (7.6): every call in either file, and every call that names a
//   member of it.
// A declaration the language makes and no file writes, such as an enum's values() (8.9.3) or a
// record's accessor (8.10.3), and an anonymous class, which has no name, are not known too.
import com.sun.source.tree.AnnotatedTypeTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.ParameterizedTypeTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.NestingKind;
import javax.lang.model.element.PackageElement;
import javax.lang.model.element.QualifiedNameable;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.ArrayType;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.IntersectionType;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.type.TypeVariable;
import javax.lang.model.type.UnionType;
import javax.lang.model.type.WildcardType;
import javax.lang.model.util.Types;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

public final class javac_links {
  static final String SOURCE = ".java";
  static final String MODULE_DECLARATION = "module-info.java";
  /** How many of javac's errors the output quotes. */
  static final int QUOTED_ERRORS = 3;

  public static void main(String[] args) throws Exception {
    Path root = Paths.get(args[0]).toAbsolutePath().normalize();
    String classPath = Paths.get(args[1]).toAbsolutePath().normalize().toString();
    List<Path> paths;
    try (Stream<Path> walk = Files.walk(root)) {
      paths = walk.filter(p -> p.toString().endsWith(SOURCE) && !p.getFileName().toString().equals(MODULE_DECLARATION) && Files.isRegularFile(p)).sorted().collect(Collectors.toList());
    }
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) {
      System.err.println("this Java has no compiler: way B needs a JDK");
      System.exit(2);
    }
    List<String> base = List.of("-proc:none", "-encoding", "UTF-8", "-Xlint:none", "-nowarn", "-classpath", classPath);

    // The source roots, from a parse of every file.
    DiagnosticCollector<JavaFileObject> parseDiags = new DiagnosticCollector<>();
    StandardJavaFileManager parseFm = compiler.getStandardFileManager(parseDiags, Locale.ROOT, StandardCharsets.UTF_8);
    JavacTask parsing = (JavacTask) compiler.getTask(null, parseFm, parseDiags, base, null, parseFm.getJavaFileObjectsFromPaths(paths));
    Set<String> roots = new LinkedHashSet<>();
    for (CompilationUnitTree cu : parsing.parse()) {
      Path dir = Paths.get(cu.getSourceFile().toUri()).getParent();
      String pkg = cu.getPackageName() == null ? "" : cu.getPackageName().toString();
      Path rootOf = dir;
      for (String part : reversed(pkg.isEmpty() ? new String[0] : pkg.split("\\."))) {
        if (rootOf == null || rootOf.getFileName() == null || !rootOf.getFileName().toString().equals(part)) {
          rootOf = null;
          break;
        }
        rootOf = rootOf.getParent();
      }
      if (rootOf != null) roots.add(rootOf.toString());
    }
    parseFm.close();

    List<String> options = new ArrayList<>(base);
    options.addAll(List.of("-Xmaxerrs", String.valueOf(Integer.MAX_VALUE)));
    if (!roots.isEmpty()) options.addAll(List.of("-sourcepath", String.join(File.pathSeparator, roots)));
    DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
    StandardJavaFileManager fm = compiler.getStandardFileManager(diags, Locale.ROOT, StandardCharsets.UTF_8);
    JavacTask task = (JavacTask) compiler.getTask(null, fm, diags, options, null, fm.getJavaFileObjectsFromPaths(paths));
    List<CompilationUnitTree> units = new ArrayList<>();
    for (CompilationUnitTree cu : task.parse()) units.add(cu);
    task.analyze();
    Trees trees = Trees.instance(task);
    Types types = task.getTypes();
    SourcePositions sp = trees.getSourcePositions();

    // javac's errors, by file: the spans they are reported at.
    Map<String, List<long[]>> errors = new HashMap<>();
    int errorCount = 0;
    List<String> firstErrors = new ArrayList<>();
    for (Diagnostic<? extends JavaFileObject> d : diags.getDiagnostics()) {
      if (d.getKind() != Diagnostic.Kind.ERROR) continue;
      errorCount++;
      String file = d.getSource() == null ? "" : relative(root, d.getSource());
      if (firstErrors.size() < QUOTED_ERRORS) firstErrors.add(file + ":" + d.getLineNumber() + ": " + d.getMessage(Locale.ROOT).lines().findFirst().orElse(""));
      if (d.getSource() == null) continue;
      // An error with no place in the file is taken to be at every place of it.
      long start = d.getStartPosition() == Diagnostic.NOPOS ? 0 : d.getStartPosition();
      long end = d.getEndPosition() == Diagnostic.NOPOS ? Long.MAX_VALUE : Math.max(d.getEndPosition(), start + 1);
      errors.computeIfAbsent(file, k -> new ArrayList<>()).add(new long[] {start, end});
    }

    // The classes two files declare (JLS 7.6), and the files that declare them.
    Map<String, Integer> declared = new HashMap<>();
    Map<CompilationUnitTree, List<String>> topLevel = new IdentityHashMap<>();
    for (CompilationUnitTree cu : units) {
      String pkg = cu.getPackageName() == null ? "" : cu.getPackageName().toString();
      List<String> names = new ArrayList<>();
      for (Tree t : cu.getTypeDecls()) if (t instanceof ClassTree) names.add((pkg.isEmpty() ? "" : pkg + ".") + ((ClassTree) t).getSimpleName());
      topLevel.put(cu, names);
      for (String n : names) declared.merge(n, 1, Integer::sum);
    }
    Set<String> twice = new HashSet<>();
    declared.forEach((n, count) -> {
      if (count > 1) twice.add(n);
    });

    Answerer answerer = new Answerer(root, trees, types, sp, twice);
    StringBuilder out = new StringBuilder();
    out.append("{\"java\":").append(quote(Runtime.version().toString())).append(",\"errors\":").append(errorCount).append(",\"firstErrors\":[");
    for (int i = 0; i < firstErrors.size(); i++) out.append(i == 0 ? "" : ",").append(quote(firstErrors.get(i)));
    out.append("],\"calls\":[");
    boolean first = true;
    for (CompilationUnitTree cu : units) {
      String file = relative(root, cu.getSourceFile());
      List<long[]> fileErrors = errors.getOrDefault(file, List.of());
      String wholeFile = topLevel.get(cu).stream().anyMatch(twice::contains) ? "two files declare a class this file declares" : answerer.taintedBy(cu, fileErrors);
      boolean staticImportFailed = cu.getImports().stream().anyMatch(i -> i.isStatic() && overlaps(sp, cu, i, fileErrors));
      for (String call : answerer.calls(cu, file, fileErrors, wholeFile, staticImportFailed)) {
        out.append(first ? "" : ",").append(call);
        first = false;
      }
    }
    System.out.println(out.append("]}"));
    fm.close();
  }

  static final class Answerer {
    final Path root;
    final Trees trees;
    final Types types;
    final SourcePositions sp;
    final Set<String> twice;
    final Map<Element, Boolean> supertypeError = new HashMap<>();

    Answerer(Path root, Trees trees, Types types, SourcePositions sp, Set<String> twice) {
      this.root = root;
      this.trees = trees;
      this.types = types;
      this.sp = sp;
      this.twice = twice;
    }

    /**
     * Why every call of the file is not known, or null: an import javac cannot find whose simple
     * name javac finds as another top-level type in the file (JLS 6.4.1).
     */
    String taintedBy(CompilationUnitTree cu, List<long[]> fileErrors) {
      Set<String> failed = new HashSet<>();
      for (ImportTree i : cu.getImports()) {
        if (i.isStatic() || !overlaps(sp, cu, i, fileErrors) || !(i.getQualifiedIdentifier() instanceof MemberSelectTree)) continue;
        String name = ((MemberSelectTree) i.getQualifiedIdentifier()).getIdentifier().toString();
        if (!name.equals("*")) failed.add(name);
      }
      if (failed.isEmpty()) return null;
      boolean[] found = {false};
      for (Tree decl : cu.getTypeDecls()) {
        new TreePathScanner<Void, Void>() {
          @Override
          public Void visitIdentifier(IdentifierTree t, Void v) {
            if (failed.contains(t.getName().toString())) {
              Element e = trees.getElement(getCurrentPath());
              if (e instanceof TypeElement && e.getEnclosingElement() instanceof PackageElement) found[0] = true;
            }
            return null;
          }
        }.scan(new TreePath(new TreePath(cu), decl), null);
      }
      return found[0] ? "an import javac cannot find names a type that javac finds elsewhere" : null;
    }

    List<String> calls(CompilationUnitTree cu, String file, List<long[]> fileErrors, String wholeFile, boolean staticImportFailed) throws java.io.IOException {
      List<String> out = new ArrayList<>();
      String text = cu.getSourceFile().getCharContent(true).toString();
      new TreePathScanner<Void, Void>() {
        void emit(Tree call, Tree name, String callee, String answer) {
          String called = name instanceof IdentifierTree ? ((IdentifierTree) name).getName().toString() : name instanceof MemberSelectTree ? ((MemberSelectTree) name).getIdentifier().toString() : "";
          if (called.isEmpty()) return;
          long at = name instanceof MemberSelectTree ? sp.getEndPosition(cu, name) - called.length() : sp.getStartPosition(cu, name);
          // A call javac makes up, such as a default constructor's `super()`, is written nowhere.
          if (!writtenAt(text, at, called)) return;
          out.add("{\"file\":" + quote(file) + ",\"pos\":" + at + ",\"line\":" + cu.getLineMap().getLineNumber(at) + ",\"name\":" + quote(called) + ",\"callee\":" + quote(callee) + ",\"answer\":" + answer + "}");
        }

        boolean errorAt(Tree call) {
          long s = sp.getStartPosition(cu, call), e = sp.getEndPosition(cu, call);
          return fileErrors.stream().anyMatch(r -> r[0] < e && r[1] > s);
        }

        @Override
        public Void visitMethodInvocation(MethodInvocationTree t, Void v) {
          ExpressionTree select = t.getMethodSelect();
          String simple = select instanceof IdentifierTree ? ((IdentifierTree) select).getName().toString() : "";
          String callee = simple.equals("this") || simple.equals("super") ? simple : select instanceof IdentifierTree ? "name" : "qualified";
          emit(t, select, callee, wholeFile != null ? notKnown(wholeFile) : errorAt(t) ? notKnown("javac reports an error at the call") : invocation(getCurrentPath(), t, callee, staticImportFailed));
          return super.visitMethodInvocation(t, v);
        }

        @Override
        public Void visitNewClass(NewClassTree t, Void v) {
          Tree type = t.getIdentifier();
          while (type instanceof ParameterizedTypeTree || type instanceof AnnotatedTypeTree)
            type = type instanceof ParameterizedTypeTree ? ((ParameterizedTypeTree) type).getType() : ((AnnotatedTypeTree) type).getUnderlyingType();
          emit(t, type, "creation", wholeFile != null ? notKnown(wholeFile) : errorAt(t) ? notKnown("javac reports an error at the call") : creation(getCurrentPath(), t, type));
          return super.visitNewClass(t, v);
        }
      }.scan(cu, null);
      return out;
    }

    String invocation(TreePath path, MethodInvocationTree t, String callee, boolean staticImportFailed) {
      Element el = trees.getElement(path);
      if (!(el instanceof ExecutableElement)) return notKnown("javac names no method");
      ExecutableElement method = (ExecutableElement) el;
      for (ExpressionTree arg : t.getArguments()) {
        TypeMirror type = trees.getTypeMirror(new TreePath(path, arg));
        if (type == null || hasError(type)) return notKnown("an argument's type is one javac cannot find");
      }
      for (VariableElement p : method.getParameters()) if (hasError(p.asType())) return notKnown("a parameter's type is one javac cannot find");
      ExpressionTree select = t.getMethodSelect();
      if (callee.equals("qualified")) {
        ExpressionTree qualifier = ((MemberSelectTree) select).getExpression();
        TypeMirror type = trees.getTypeMirror(new TreePath(new TreePath(path, select), qualifier));
        if (type == null || restsOnError(type)) return notKnown("the type the method is looked up in has a type javac cannot find");
      } else if (callee.equals("name")) {
        String why = scopeError(path, method.getEnclosingElement());
        if (why != null) return why;
        if (!memberOfEnclosing(path, method.getEnclosingElement()) && staticImportFailed) return notKnown("a static import javac cannot find may name an overload");
      }
      return target(method.getKind() == ElementKind.CONSTRUCTOR ? method.getEnclosingElement() : method);
    }

    String creation(TreePath path, NewClassTree t, Tree type) {
      Element el = trees.getElement(path);
      if (!(el instanceof ExecutableElement)) return notKnown("javac names no constructor");
      Element cls = el.getEnclosingElement();
      if (!(cls instanceof TypeElement) || ((TypeElement) cls).getNestingKind() == NestingKind.ANONYMOUS) return notKnown("an anonymous class has no name");
      if (t.getEnclosingExpression() != null) {
        TypeMirror outer = trees.getTypeMirror(new TreePath(path, t.getEnclosingExpression()));
        if (outer == null || restsOnError(outer)) return notKnown("the type the class is looked up in has a type javac cannot find");
      } else if (type instanceof IdentifierTree) {
        String why = scopeError(path, cls.getEnclosingElement());
        if (why != null) return why;
      } else if (type instanceof MemberSelectTree) {
        Element qualifier = trees.getElement(new TreePath(new TreePath(path, type), ((MemberSelectTree) type).getExpression()));
        if (qualifier instanceof TypeElement && restsOnError(qualifier.asType())) return notKnown("the type the class is looked up in has a type javac cannot find");
      }
      return target(cls);
    }

    /**
     * For a simple name: each class around the call, from the innermost out to the one the name is
     * a member of, must have no supertype javac cannot find (JLS 15.12.1, 6.5.5.1).
     */
    String scopeError(TreePath path, Element owner) {
      for (TreePath p = path; p != null; p = p.getParentPath()) {
        if (!(p.getLeaf() instanceof ClassTree)) continue;
        Element c = trees.getElement(p);
        if (!(c instanceof TypeElement)) return notKnown("javac names no class around the call");
        if (restsOnError(c.asType())) return notKnown("a class around the call has a supertype javac cannot find");
        if (isMemberOf(c, owner)) return null;
      }
      return null;
    }

    boolean memberOfEnclosing(TreePath path, Element owner) {
      for (TreePath p = path; p != null; p = p.getParentPath()) {
        if (p.getLeaf() instanceof ClassTree && isMemberOf(trees.getElement(p), owner)) return true;
      }
      return false;
    }

    boolean isMemberOf(Element c, Element owner) {
      if (!(c instanceof TypeElement) || !(owner instanceof TypeElement)) return false;
      return c.equals(owner) || types.isSubtype(types.erasure(c.asType()), types.erasure(owner.asType()));
    }

    /** The answer for a declaration javac names. */
    String target(Element target) {
      Element outermost = target;
      while (!(outermost.getEnclosingElement() instanceof PackageElement) && outermost.getEnclosingElement() != null) outermost = outermost.getEnclosingElement();
      if (!(outermost instanceof TypeElement)) return notKnown("javac names no class");
      if (trees.getPath(outermost) == null) return "{\"outside\":" + quote(qualified(target)) + "}";
      if (twice.contains(((TypeElement) outermost).getQualifiedName().toString())) return notKnown("two files declare its class");
      TreePath at = trees.getPath(target);
      if (at == null || at.getLeaf() == null) return notKnown("the language declares it: no file writes it");
      CompilationUnitTree cu = at.getCompilationUnit();
      long start = sp.getStartPosition(cu, at.getLeaf()), end = sp.getEndPosition(cu, at.getLeaf());
      if (start < 0 || end < 0) return notKnown("the language declares it: no file writes it");
      String name = target.getSimpleName().toString();
      return "{\"repo\":{\"file\":" + quote(relative(root, cu.getSourceFile())) + ",\"name\":" + quote(name) + ",\"start\":" + cu.getLineMap().getLineNumber(start) + ",\"end\":" + cu.getLineMap().getLineNumber(Math.max(start, end - 1)) + "}}";
    }

    /** Whether the type, or any of its supertypes, is or holds a type javac cannot find. */
    boolean restsOnError(TypeMirror type) {
      if (hasError(type)) return true;
      if (type.getKind() == TypeKind.DECLARED) {
        Element e = ((DeclaredType) type).asElement();
        Boolean known = supertypeError.get(e);
        if (known != null) return known;
        supertypeError.put(e, false);
        boolean found = false;
        for (TypeMirror s : types.directSupertypes(e.asType())) if (restsOnError(s)) found = true;
        supertypeError.put(e, found);
        return found;
      }
      if (type.getKind() == TypeKind.TYPEVAR || type.getKind() == TypeKind.ARRAY || type.getKind() == TypeKind.INTERSECTION) {
        for (TypeMirror s : types.directSupertypes(type)) if (restsOnError(s)) return true;
      }
      return false;
    }
  }

  /** Whether the type is, or holds, a type javac cannot find. */
  static boolean hasError(TypeMirror type) {
    return hasError(type, Collections.newSetFromMap(new IdentityHashMap<>()));
  }

  static boolean hasError(TypeMirror type, Set<Element> seen) {
    if (type == null) return false;
    switch (type.getKind()) {
      case ERROR:
        return true;
      case DECLARED: {
        DeclaredType d = (DeclaredType) type;
        for (TypeMirror a : d.getTypeArguments()) if (hasError(a, seen)) return true;
        return hasError(d.getEnclosingType(), seen);
      }
      case ARRAY:
        return hasError(((ArrayType) type).getComponentType(), seen);
      case TYPEVAR: {
        TypeVariable v = (TypeVariable) type;
        if (!seen.add(v.asElement())) return false;
        return hasError(v.getUpperBound(), seen) || hasError(v.getLowerBound(), seen);
      }
      case WILDCARD: {
        WildcardType w = (WildcardType) type;
        return hasError(w.getExtendsBound(), seen) || hasError(w.getSuperBound(), seen);
      }
      case INTERSECTION:
        for (TypeMirror b : ((IntersectionType) type).getBounds()) if (hasError(b, seen)) return true;
        return false;
      case UNION:
        for (TypeMirror b : ((UnionType) type).getAlternatives()) if (hasError(b, seen)) return true;
        return false;
      default:
        return false;
    }
  }

  /** Whether `name` is the whole identifier written at `at`. */
  static boolean writtenAt(String text, long at, String name) {
    long end = at + name.length();
    return at >= 0 && end <= text.length() && text.startsWith(name, (int) at) && (end == text.length() || !Character.isJavaIdentifierPart(text.charAt((int) end)));
  }

  static boolean overlaps(SourcePositions sp, CompilationUnitTree cu, Tree t, List<long[]> fileErrors) {
    long s = sp.getStartPosition(cu, t), e = sp.getEndPosition(cu, t);
    return fileErrors.stream().anyMatch(r -> r[0] < e && r[1] > s);
  }

  static String qualified(Element e) {
    String own = e.getSimpleName().toString();
    Element owner = e.getEnclosingElement();
    if (e instanceof QualifiedNameable) return ((QualifiedNameable) e).getQualifiedName().toString();
    return owner instanceof QualifiedNameable ? ((QualifiedNameable) owner).getQualifiedName() + "." + own : own;
  }

  static String notKnown(String why) {
    return "{\"notKnown\":" + quote(why) + "}";
  }

  static String[] reversed(String[] parts) {
    String[] out = new String[parts.length];
    for (int i = 0; i < parts.length; i++) out[i] = parts[parts.length - 1 - i];
    return out;
  }

  static String relative(Path root, JavaFileObject file) {
    return root.relativize(Paths.get(file.toUri()).normalize()).toString().replace(File.separatorChar, '/');
  }

  static String quote(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c < 0x20 || c > 0x7e) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }
}
