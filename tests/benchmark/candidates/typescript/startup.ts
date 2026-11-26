// The start-up cost of each candidate tool for way B (trustmybot/tmb#338): in a fresh Bun process,
// the time to load the tool and have it answer one call of a two-file project. Research only.
//
//   TMB_CANDIDATE_TS7=<typescript@7 package folder> bun tests/benchmark/candidates/typescript/startup.ts [samples]
//
// TypeScript 5.9 is loaded as tmb loads it (carried.ts). TypeScript 7 is reached through its
// asynchronous API, which runs under Bun (its synchronous one does not; ts7-bridge.mjs), so this
// is the cost tmb itself would pay.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ts7Package } from "./ts7.ts";

const DEFAULT_SAMPLES = 5;
const CART = "export class Cart { total(): number { return 1; } }\nexport function makeCart() { return new Cart(); }\n";
const CHECKOUT = 'import { makeCart } from "./cart";\nconst c = makeCart();\nc.total();\n';

/** One sample, in this process: milliseconds to load the tool, and to open the project and answer the call. */
async function sample(which: string, dir: string): Promise<{ load: number; first: number; resolved: string }> {
  const t0 = performance.now();
  const pos = CHECKOUT.indexOf("total");
  if (which === "ts5") {
    const { loadCarried } = await import("../../../../src/engine/graph/languages/typescript/carried.ts");
    const { ts } = loadCarried();
    const t1 = performance.now();
    const program = ts.createProgram([path.join(dir, "checkout.ts")], { noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
    const sf = program.getSourceFile(path.join(dir, "checkout.ts"))!;
    const find = (n: import("typescript5").Node): import("typescript5").Node | undefined => (n.getStart(sf) === pos && ts.isIdentifier(n) ? n : ts.forEachChild(n, find));
    const sym = program.getTypeChecker().getSymbolAtLocation(find(sf)!);
    const d = sym?.declarations?.[0];
    return { load: t1 - t0, first: performance.now() - t1, resolved: `${path.basename(d?.getSourceFile().fileName ?? "")} ${sym?.name}` };
  }
  const pkg = ts7Package();
  if ("unavailable" in pkg) throw new Error(pkg.unavailable);
  const { API } = await import(path.join(pkg.folder, "dist/api/async/api.js"));
  const t1 = performance.now();
  const api = new API({ cwd: dir });
  writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, target: "esnext", module: "esnext", moduleResolution: "bundler" }, files: ["checkout.ts"] }));
  const snap = await api.updateSnapshot({ openProjects: [path.join(dir, "tsconfig.json")] });
  const project = snap.getProjects()[0];
  const sym = await project.checker.getSymbolAtPosition(path.join(dir, "checkout.ts"), pos);
  const resolved = `${path.basename(sym?.declarations?.[0]?.path ?? "")} ${sym?.name}`;
  const first = performance.now() - t1;
  await api.close();
  return { load: t1 - t0, first, resolved };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function main(args: string[]): Promise<void> {
  if (args[0] === "--sample") {
    console.log(JSON.stringify(await sample(args[1]!, args[2]!)));
    return;
  }
  const n = Number(args[0] ?? DEFAULT_SAMPLES);
  const dir = mkdtempSync(path.join(tmpdir(), "tmb-startup-"));
  try {
    writeFileSync(path.join(dir, "cart.ts"), CART);
    writeFileSync(path.join(dir, "checkout.ts"), CHECKOUT);
    for (const which of ["ts5", "ts7"]) {
      const runs: { load: number; first: number; resolved: string; process: number }[] = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        const r = spawnSync(process.execPath, [import.meta.path, "--sample", which, dir], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${which}: ${r.stderr}`);
        runs.push({ ...JSON.parse(r.stdout.trim().split("\n").at(-1)!), process: performance.now() - t });
      }
      console.log(
        `${which}: load ${median(runs.map((r) => r.load)).toFixed(0)} ms, open and answer one call ${median(runs.map((r) => r.first)).toFixed(0)} ms, whole process ${median(runs.map((r) => r.process)).toFixed(0)} ms (median of ${n}); resolved: ${runs[0]?.resolved}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main(process.argv.slice(2));
