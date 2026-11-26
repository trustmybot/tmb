// The TypeScript 7 compiler (the native one, written in Go) as a candidate for way B
// (trustmybot/tmb#338). Research only: nothing in src/ uses it.
//
//   node ts7-bridge.mjs <typescript-7-package-folder> <input.json> <output.json> [base options as JSON]
//
// The base options, when given, are laid over tool.ts's base options, under the project's own:
// the control run gives TypeScript 5.9's default of an option whose default TypeScript 6 changed.
//
// It runs under Node, not Bun: TypeScript 7's synchronous API reads its pipe through Node's
// internal `_handle.fd`, which Bun does not have. The input is what way B gives its tool
// (src/engine/graph/languages/contract.ts, ToolInput), with the repo's folder; the output is one
// answer per call, in order, as tool.ts gives them. The per-call rule is tool.ts's own, asked of
// TypeScript 7 instead of TypeScript 5.9:
// - the compiler's calls are found in its own syntax tree, and a call of the graph is answered by
//   the compiler's call at its position, of its name (or the name an import under a new name
//   declares); a call the compiler has none at is not known;
// - the callee's symbol, through an import to what it imports, names its declarations; none in
//   the repo is outside; in the repo, exactly one node of the graph matched by place is linked;
//   else not known.
// The program reads the repo's files from the commit (the input's texts), the installed packages
// from the working tree, and the project's root settings file, as tool.ts's program does: every
// file is a root, with the options tool.ts uses over the project's own.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [pkg, inputFile, outputFile, extraBase] = process.argv.slice(2);
if (pkg === undefined || inputFile === undefined || outputFile === undefined) {
  console.error("usage: node ts7-bridge.mjs <typescript-7-package-folder> <input.json> <output.json>");
  process.exit(2);
}
const load = (rel) => import(pathToFileURL(path.join(pkg, rel)).href);
const { API, SymbolFlags } = await load("dist/api/sync/api.js");
const ast = await load("dist/ast/index.js");
const version = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8")).version;

const input = JSON.parse(readFileSync(inputFile, "utf8"));
const root = path.resolve(input.root);
const texts = new Map([...Object.entries(input.configs), ...Object.entries(input.files)]);

/** The folder a package manager installs a project's dependencies in (compiler.ts). */
const INSTALLED_DIR = "node_modules";
/** The settings files a project's compiler options come from, at the repo's top, the first present (compiler.ts). */
const PROJECT_CONFIGS = ["tsconfig.json", "jsconfig.json"];
/**
 * The program's own settings, served beside the repo's and never written to disk: tool.ts's base
 * options (compiler.ts, baseOptions), then the project's own over them, then tool.ts's last word.
 */
const BASE_CONFIG = path.join(root, ".tmb-candidate-base.json");
const PROGRAM_CONFIG = path.join(root, ".tmb-candidate.json");
const projectConfig = PROJECT_CONFIGS.find((n) => texts.has(n));
const virtual = new Map([
  [
    BASE_CONFIG,
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        jsx: "preserve",
        target: "esnext",
        module: "esnext",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        noEmit: true,
        skipLibCheck: true,
        ...(extraBase === undefined ? {} : JSON.parse(extraBase)),
      },
    }),
  ],
  [
    PROGRAM_CONFIG,
    JSON.stringify({
      extends: [BASE_CONFIG, ...(projectConfig === undefined ? [] : [path.join(root, projectConfig)])],
      compilerOptions: { noEmit: true, allowJs: true, skipLibCheck: true },
      files: Object.keys(input.files).map((f) => path.join(root, f)),
      include: [],
    }),
  ],
]);

const dirs = new Set([root]);
for (const file of texts.keys()) for (let d = path.posix.dirname(file); d !== "."; d = path.posix.dirname(d)) dirs.add(path.join(root, d));

/** Where a file is read: the program's own settings, the commit, or the disk (undefined: the real file system). */
function placeOf(file) {
  const abs = path.resolve(file);
  if (virtual.has(abs)) return { from: "virtual", abs };
  if (abs !== root && !abs.startsWith(root + path.sep)) return { from: "disk" };
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel.split("/").includes(INSTALLED_DIR)) return { from: "disk" };
  return { from: "commit", rel, abs };
}

const fs = {
  readFile(file) {
    const p = placeOf(file);
    if (p.from === "disk") return undefined;
    if (p.from === "virtual") return virtual.get(p.abs);
    return texts.get(p.rel) ?? null;
  },
  fileExists(file) {
    const p = placeOf(file);
    if (p.from === "disk") return undefined;
    return p.from === "virtual" || texts.has(p.rel);
  },
  directoryExists(dir) {
    const p = placeOf(dir);
    if (p.from === "disk") return undefined;
    if (p.from === "virtual") return false;
    if (dirs.has(p.abs)) return true;
    // The installed packages' folder, which git does not hold.
    return path.basename(p.abs) === INSTALLED_DIR ? undefined : false;
  },
  getAccessibleEntries(dir) {
    const p = placeOf(dir);
    if (p.from === "disk") return undefined;
    const files = [];
    const directories = new Set();
    const prefix = p.from === "commit" && p.rel !== "" ? `${p.rel}/` : "";
    for (const rel of texts.keys()) {
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) files.push(rest);
      else directories.add(rest.slice(0, slash));
    }
    return { files, directories: [...directories] };
  },
  realpath(file) {
    return placeOf(file).from === "disk" ? undefined : path.resolve(file);
  },
};

const timing = {};
const t0 = performance.now();
const api = new API({ cwd: root, fs });
const snapshot = api.updateSnapshot({ openProjects: [PROGRAM_CONFIG] });
const project = snapshot.getProject(PROGRAM_CONFIG) ?? snapshot.getProjects()[0];
if (project === undefined) throw new Error("TypeScript 7 opened no project");
const { checker, program } = project;
timing.open = performance.now() - t0;

const rel = (file) => path.relative(root, file).split(path.sep).join("/");
// A declaration's handle names its file by the compiler's path, which is lower case on a file
// system that ignores case: each file of the repo is known by that path too.
const repoPaths = new Set();
for (const f of Object.keys(input.files)) {
  const abs = path.join(root, f);
  repoPaths.add(abs);
  repoPaths.add(abs.toLowerCase());
}
const inRepo = (file) => repoPaths.has(file);

const nodesByFile = new Map();
input.nodes.forEach((node, index) => {
  const here = nodesByFile.get(node.path) ?? [];
  here.push({ index, node });
  nodesByFile.set(node.path, here);
});

// Line starts of each file, for a position's line; positions are the compiler's, in the file's text.
const lineStarts = new Map();
function lineOf(file, pos) {
  let starts = lineStarts.get(file);
  if (starts === undefined) {
    starts = ast.computeLineStarts(texts.get(rel(file)) ?? program.getSourceFile(file)?.text ?? "");
    lineStarts.set(file, starts);
  }
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
const startOf = (n) => n.getStart(n.getSourceFile());

/** A function or a class written as a value (tool.ts). */
const isFunctionValue = (e) => e !== undefined && (ast.isArrowFunction(e) || ast.isFunctionExpression(e) || ast.isClassExpression(e));
/** TypeScript 5's isFunctionLike: every signature declaration, with a body or not. */
const isFunctionLike = (n) => ast.isSignatureDeclaration(n);
function insideCallable(d) {
  for (let n = d.parent; n !== undefined; n = n.parent) if (isFunctionLike(n)) return true;
  return false;
}
/** Whether a declaration is a node of the graph by "Kinds of symbol" (tool.ts, isNodeDeclaration). */
function isNodeDeclaration(d) {
  if (isFunctionLike(d)) return d.body !== undefined && d.body !== null;
  if (ast.isClassLikeDeclaration(d)) return true;
  if (ast.isPropertyDeclaration(d) || ast.isPropertyAssignment(d)) return isFunctionValue(d.initializer);
  if (ast.isVariableDeclaration(d)) return isFunctionValue(d.initializer) || !insideCallable(d);
  if (ast.isBindingElement(d)) return !insideCallable(d);
  return false;
}
function declaredName(d) {
  const name = d.name;
  if (name === undefined || name === null) return null;
  if (ast.isIdentifier(name) || ast.isPrivateIdentifier(name) || ast.isStringLiteral(name) || ast.isNumericLiteral(name)) return name.text;
  return null;
}

/** The node a declaration in the repo is, by place (tool.ts, nodesOf). */
function nodesOf(d) {
  const name = declaredName(d);
  if (name === null || !isNodeDeclaration(d)) return [];
  const file = d.getSourceFile().fileName;
  const start = lineOf(file, startOf(d));
  const end = lineOf(file, d.end);
  const overlapping = (nodesByFile.get(rel(file)) ?? []).filter(({ node }) => node.name === name && node.start <= end && node.end >= start);
  if (overlapping.length <= 1) return overlapping.map(({ index }) => index);
  const starts = new Set([start, ...[d.name, d.initializer].filter((n) => n !== undefined && n !== null).map((n) => lineOf(file, startOf(n)))]);
  const starting = overlapping.filter(({ node }) => starts.has(node.start));
  return (starting.length === 1 ? starting : overlapping).map(({ index }) => index);
}

const NOT_KNOWN = { state: "not_known" };
const OUTSIDE = { state: "outside" };

const aliased = new Map();
function answerOf(sym) {
  if (sym === undefined || sym === null) return NOT_KNOWN;
  if (sym.flags & SymbolFlags.Alias) {
    let target = aliased.get(sym.id);
    if (target === undefined) {
      try {
        target = checker.getAliasedSymbol(sym);
        if (checker.isUnknownSymbol(target)) target = null;
      } catch {
        target = null;
      }
      aliased.set(sym.id, target);
    }
    if (target === null) return NOT_KNOWN;
    sym = target;
  }
  const handles = sym.declarations ?? [];
  if (handles.length === 0) return NOT_KNOWN;
  const own = handles.filter((h) => inRepo(h.path));
  if (own.length === 0) return OUTSIDE;
  const nodes = new Set();
  for (const h of own) {
    const d = h.resolve();
    if (d === undefined) return NOT_KNOWN;
    for (const i of nodesOf(d)) nodes.add(i);
  }
  return nodes.size === 1 ? { node: [...nodes][0] } : NOT_KNOWN;
}

/** A call or a construction (compiler.ts, isCallNode). */
const isCallNode = (n) => ast.isCallExpression(n) || ast.isNewExpression(n) || ast.isTaggedTemplateExpression(n);
/** The name a call calls (compiler.ts, calleeOf). */
function calleeOf(node) {
  const name = (e) => {
    if (ast.isIdentifier(e)) return e;
    if (ast.isPropertyAccessExpression(e)) return e.name;
    if (ast.isParenthesizedExpression(e)) return name(e.expression);
    return null;
  };
  if (ast.isCallExpression(node) || ast.isNewExpression(node)) return name(node.expression);
  if (ast.isTaggedTemplateExpression(node)) return name(node.tag);
  return null;
}
/** `import { a as b }` (compiler.ts, originalNames). */
function originalNames(sf) {
  const out = new Map();
  for (const stmt of sf.statements) {
    const bindings = ast.isImportDeclaration(stmt) ? stmt.importClause?.namedBindings : undefined;
    if (bindings !== undefined && bindings !== null && ast.isNamedImports(bindings)) for (const el of bindings.elements) if (el.propertyName) out.set(el.name.text, el.propertyName.text);
  }
  return out;
}

const placeKey = (pos, name) => `${pos}\u0000${name}`;
const byFile = new Map();
function callsOf(file) {
  const known = byFile.get(file);
  if (known !== undefined) return known;
  const out = new Map();
  byFile.set(file, out);
  const abs = path.join(root, file);
  const sf = program.getSourceFile(abs);
  if (sf === undefined) return out;
  const original = originalNames(sf);
  const callees = [];
  const visit = (node) => {
    if (isCallNode(node)) {
      const callee = calleeOf(node);
      if (callee !== null) callees.push(callee);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  if (callees.length === 0) return out;
  const symbols = checker.getSymbolAtLocation(callees);
  callees.forEach((callee, i) => {
    const answer = answerOf(symbols[i]);
    const pos = startOf(callee);
    for (const name of new Set([callee.text, original.get(callee.text) ?? callee.text])) out.set(placeKey(pos, name), answer);
  });
  return out;
}

const t1 = performance.now();
const answers = input.calls.map((call) => callsOf(call.path).get(placeKey(call.pos, call.name)) ?? NOT_KNOWN);
timing.answer = performance.now() - t1;
api.close();
writeFileSync(outputFile, JSON.stringify({ version, answers, timing }));
