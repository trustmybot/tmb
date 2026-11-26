// The benchmark's reference for Java's functions and calls (trustmybot/tmb#353): javac's own parser,
// through the JDK's compiler API (javax.tools and com.sun.source), so it runs with any JDK and
// downloads nothing. It only parses: it reads no class path, attributes nothing and runs nothing.
//
// Usage: java java_reference.java <folder>. It reads every .java file under the folder and writes,
// for each, the functions javac's parser finds and how many calls each holds:
//
//   {"version": "javac 21.0.1", "files": {path: {"functions": ["start-end", ...], "calls": {"start-end" or "": n}}
//                                         or {"error": "why javac's parser cannot read it"}}}
//
// A function, by the Java Language Specification (Java SE 21) and CODE_GRAPH.md's "Kinds of symbol":
// a method (JLS 8.4, 9.4), an annotation interface element (9.6.1), a constructor (8.8), a compact
// constructor (8.10.4), each a MethodTree, wherever it is written; and a lambda expression (15.27).
// Its lines run from its first modifier or annotation to its last line.
//
// A call (CODE_GRAPH.md, "The three states of a call") is a method invocation (15.12), an explicit
// constructor invocation `this(…)` or `super(…)` (8.8.7.1), which the parser writes as one, and a
// class instance creation (15.9), each written in the file at the name it calls. An enum constant
// is no creation written in the file (8.9.1). It belongs to the innermost method, constructor or
// lambda around it; in a named type's body outside those, to the file (""): the type that holds a
// field's value or an initializer is no function. An anonymous class body (15.9.5) is no named type,
// so a call there belongs to what is around it.
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.AnnotatedTypeTree;
import com.sun.source.tree.ParameterizedTypeTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

public final class java_reference {
  static final String SOURCE = ".java";

  public static void main(String[] args) throws Exception {
    Path root = Paths.get(args[0]).toAbsolutePath().normalize();
    List<Path> paths;
    try (Stream<Path> walk = Files.walk(root)) {
      paths = walk.filter(p -> p.toString().endsWith(SOURCE) && Files.isRegularFile(p)).sorted().toList();
    }
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
    StandardJavaFileManager fm = compiler.getStandardFileManager(diags, Locale.ROOT, StandardCharsets.UTF_8);
    JavacTask task = (JavacTask) compiler.getTask(null, fm, diags, List.of("-proc:none", "-encoding", "UTF-8", "-Xmaxerrs", "1000000"), null, fm.getJavaFileObjectsFromPaths(paths));
    Iterable<? extends CompilationUnitTree> units = task.parse();
    SourcePositions sp = Trees.instance(task).getSourcePositions();
    Map<String, String> errors = new TreeMap<>();
    for (Diagnostic<? extends JavaFileObject> d : diags.getDiagnostics()) {
      if (d.getKind() == Diagnostic.Kind.ERROR && d.getSource() != null) errors.putIfAbsent(relative(root, d.getSource()), d.getLineNumber() + ": " + d.getMessage(Locale.ROOT));
    }
    Map<String, String> files = new TreeMap<>();
    for (CompilationUnitTree cu : units) {
      String file = relative(root, cu.getSourceFile());
      if (errors.containsKey(file)) {
        files.put(file, "{\"error\":" + quote(errors.get(file)) + "}");
        continue;
      }
      String text = cu.getSourceFile().getCharContent(true).toString();
      List<String> functions = new ArrayList<>();
      Map<String, Integer> calls = new TreeMap<>();
      new TreePathScanner<Void, String>() {
        String span(Tree t) {
          long start = sp.getStartPosition(cu, t), end = sp.getEndPosition(cu, t);
          return cu.getLineMap().getLineNumber(start) + "-" + cu.getLineMap().getLineNumber(Math.max(start, end - 1));
        }

        void call(Tree name, String owner) {
          String called = name instanceof IdentifierTree i ? i.getName().toString() : name instanceof MemberSelectTree m ? m.getIdentifier().toString() : "";
          long at = name instanceof MemberSelectTree ? sp.getEndPosition(cu, name) - called.length() : sp.getStartPosition(cu, name);
          if (!called.isEmpty() && writtenAt(text, (int) at, called)) calls.merge(owner, 1, Integer::sum);
        }

        @Override
        public Void visitClass(ClassTree t, String owner) {
          return super.visitClass(t, t.getSimpleName().isEmpty() ? owner : "");
        }

        @Override
        public Void visitMethod(MethodTree t, String owner) {
          String key = span(t);
          functions.add(key);
          return super.visitMethod(t, key);
        }

        @Override
        public Void visitLambdaExpression(LambdaExpressionTree t, String owner) {
          String key = span(t);
          functions.add(key);
          return super.visitLambdaExpression(t, key);
        }

        @Override
        public Void visitMethodInvocation(MethodInvocationTree t, String owner) {
          call(t.getMethodSelect(), owner);
          return super.visitMethodInvocation(t, owner);
        }

        @Override
        public Void visitNewClass(NewClassTree t, String owner) {
          Tree type = t.getIdentifier();
          while (type instanceof ParameterizedTypeTree || type instanceof AnnotatedTypeTree)
            type = type instanceof ParameterizedTypeTree p ? p.getType() : ((AnnotatedTypeTree) type).getUnderlyingType();
          call(type, owner);
          return super.visitNewClass(t, owner);
        }
      }.scan(cu, "");
      functions.sort(null);
      StringBuilder counts = new StringBuilder();
      for (Map.Entry<String, Integer> e : calls.entrySet()) counts.append(counts.length() == 0 ? "" : ",").append(quote(e.getKey())).append(':').append(e.getValue());
      List<String> quoted = functions.stream().map(java_reference::quote).toList();
      files.put(file, "{\"functions\":[" + String.join(",", quoted) + "],\"calls\":{" + counts + "}}");
    }
    StringBuilder out = new StringBuilder("{\"version\":").append(quote("javac " + Runtime.version())).append(",\"files\":{");
    String sep = "";
    for (Map.Entry<String, String> e : files.entrySet()) {
      out.append(sep).append(quote(e.getKey())).append(':').append(e.getValue());
      sep = ",";
    }
    System.out.println(out.append("}}"));
  }

  /** Whether `name` is the whole identifier written at `at`: a call the parser makes up, such as an enum constant's creation, is not. */
  static boolean writtenAt(String text, int at, String name) {
    int end = at + name.length();
    return at >= 0 && text.startsWith(name, at) && (end >= text.length() || !Character.isJavaIdentifierPart(text.charAt(end)));
  }

  static String relative(Path root, JavaFileObject file) {
    return root.relativize(Paths.get(file.toUri()).normalize()).toString().replace(File.separatorChar, '/');
  }

  static String quote(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }
}
