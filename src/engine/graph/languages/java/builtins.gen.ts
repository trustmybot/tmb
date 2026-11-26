// Writes builtins.ts (trustmybot/tmb#353): what Java declares for every program without a file of
// the repo, as the JDK found on PATH lists it by reflection. Nothing is typed out by hand.
// - The public types of `java.lang`, which every compilation unit imports on demand (JLS 7.3).
// - The members each kind of type declaration gets from the supertype the language gives it when
//   the declaration names none: a class from `Object` (JLS 8.1.4), an enum from `Enum` (8.9), a
//   record from `Record` (8.10), an interface the public methods of `Object` (9.2), an annotation
//   interface those and `java.lang.annotation.Annotation`'s (9.6). Each is the names of its
//   methods, member types and fields a subclass inherits: public or protected (8.2, 8.4.8).
// Run it with the JDK the lists should follow: `bun src/engine/graph/languages/java/builtins.gen.ts`.
// A test fails when builtins.ts is not what this writes with the same Java release, and is
// skipped, saying why, without one.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The file this writes, beside it. */
export const BUILTINS_FILE = path.join(import.meta.dir, "builtins.ts");

/** Asks the JDK's own classes, by reflection, and prints JSON. */
const PROGRAM = `import java.lang.module.ModuleFinder;
import java.lang.module.ModuleReader;
import java.lang.reflect.Member;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

public class Main {
  static final String PACKAGE = "java/lang/";
  static final String CLASS = ".class";

  public static void main(String[] args) throws Exception {
    TreeSet<String> types = new TreeSet<>();
    try (ModuleReader reader = ModuleFinder.ofSystem().find("java.base").orElseThrow().open()) {
      for (String entry : (Iterable<String>) reader.list()::iterator) {
        String rest = entry.startsWith(PACKAGE) && entry.endsWith(CLASS) ? entry.substring(PACKAGE.length(), entry.length() - CLASS.length()) : "";
        if (rest.isEmpty() || rest.contains("/") || rest.contains("$") || rest.equals("module-info") || rest.equals("package-info")) continue;
        Class<?> c = Class.forName("java.lang." + rest, false, null);
        if (Modifier.isPublic(c.getModifiers())) types.add(c.getSimpleName());
      }
    }
    Map<String, Map<String, TreeSet<String>>> kinds = new TreeMap<>();
    kinds.put("class", inherited(List.of(Object.class), false));
    kinds.put("enum", inherited(List.of(Enum.class), false));
    kinds.put("record", inherited(List.of(Record.class), false));
    kinds.put("interface", inherited(List.of(Object.class), true));
    kinds.put("annotation", inherited(List.of(Object.class, java.lang.annotation.Annotation.class), true));
    StringBuilder out = new StringBuilder();
    out.append("{\\"version\\":\\"").append(Runtime.version().feature()).append("\\",\\"types\\":").append(list(types)).append(",\\"kinds\\":{");
    String sep = "";
    for (var k : kinds.entrySet()) {
      out.append(sep).append('"').append(k.getKey()).append("\\":{");
      String inner = "";
      for (var m : k.getValue().entrySet()) {
        out.append(inner).append('"').append(m.getKey()).append("\\":").append(list(m.getValue()));
        inner = ",";
      }
      out.append('}');
      sep = ",";
    }
    System.out.println(out.append("}}"));
  }

  /** What a subclass inherits from these supertypes: public or protected members; only public ones for an interface (JLS 9.2). */
  static Map<String, TreeSet<String>> inherited(List<Class<?>> supers, boolean publicOnly) {
    Map<String, TreeSet<String>> out = new TreeMap<>();
    TreeSet<String> methods = new TreeSet<>(), types = new TreeSet<>(), fields = new TreeSet<>();
    for (Class<?> top : supers) {
      for (Class<?> c = top; c != null; c = c.getSuperclass()) {
        for (Member m : c.getDeclaredMethods()) if (reaches(m.getModifiers(), publicOnly) && !m.isSynthetic()) methods.add(m.getName());
        for (Member f : c.getDeclaredFields()) if (reaches(f.getModifiers(), publicOnly) && !f.isSynthetic()) fields.add(f.getName());
        for (Class<?> t : c.getDeclaredClasses()) if (reaches(t.getModifiers(), publicOnly)) types.add(t.getSimpleName());
      }
      for (Member m : top.getMethods()) methods.add(m.getName());
      for (Class<?> t : top.getClasses()) types.add(t.getSimpleName());
      for (Member f : top.getFields()) fields.add(f.getName());
    }
    out.put("methods", methods);
    out.put("types", types);
    out.put("fields", fields);
    return out;
  }

  static boolean reaches(int modifiers, boolean publicOnly) {
    return Modifier.isPublic(modifiers) || (!publicOnly && Modifier.isProtected(modifiers));
  }

  static String list(TreeSet<String> names) {
    List<String> quoted = new ArrayList<>();
    for (String n : names) quoted.add('"' + n + '"');
    return "[" + String.join(",", quoted) + "]";
  }
}
`;

/** The kinds of type declaration, by the supertype Java gives each that names none. */
export const DECLARATION_KINDS = ["class", "enum", "record", "interface", "annotation"] as const;
export type DeclarationKind = (typeof DECLARATION_KINDS)[number];

/** The names of a supertype's members a subclass inherits. */
export type Inherited = { methods: string[]; types: string[]; fields: string[] };

export type JavaBuiltins = { version: string; types: string[]; kinds: Record<DeclarationKind, Inherited> };

/** What the JDK on PATH declares, by its feature release (`21`), or null when there is none. */
export function javaBuiltins(java = "java"): JavaBuiltins | null {
  const dir = mkdtempSync(path.join(tmpdir(), "tmb-java-builtins-"));
  try {
    const file = path.join(dir, "Main.java");
    writeFileSync(file, PROGRAM);
    const run = spawnSync(java, [file], { encoding: "utf8", cwd: dir });
    if (run.error !== undefined || run.status !== 0) return null;
    return JSON.parse(run.stdout) as JavaBuiltins;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const set = (names: readonly string[]): string => `new Set<string>(${JSON.stringify(names)})`;

/** builtins.ts as this writes it from `b`. */
export function builtinsText(b: JavaBuiltins): string {
  const kinds = DECLARATION_KINDS.map(
    (k) => `  ${k}: { methods: ${set(b.kinds[k].methods)}, types: ${set(b.kinds[k].types)}, fields: ${set(b.kinds[k].fields)} },`,
  );
  return [
    `// Generated by builtins.gen.ts from Java ${b.version}'s own classes. Do not edit.`,
    `export const BUILTINS_JAVA_VERSION = ${JSON.stringify(b.version)};`,
    "",
    "/** The public types of `java.lang`, which every file imports on demand (JLS 7.3). */",
    `export const JAVA_LANG_TYPES: ReadonlySet<string> = ${set(b.types)};`,
    "",
    "/** What a type declaration that names no supertype inherits from the one Java gives it, by its kind. */",
    "export const INHERITED: Record<string, { methods: ReadonlySet<string>; types: ReadonlySet<string>; fields: ReadonlySet<string> }> = {",
    ...kinds,
    "};",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const b = javaBuiltins();
  if (b === null) {
    console.error("no `java` on PATH: install a JDK to write the Java built-ins");
    process.exit(1);
  }
  writeFileSync(BUILTINS_FILE, builtinsText(b));
  console.log(`wrote ${BUILTINS_FILE} from Java ${b.version}`);
}
