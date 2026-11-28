// Compiles the tmb executable with Bun.
//   bun scripts/build.ts            every release target into dist/tmb-<os>-<arch>[.exe]
//   bun scripts/build.ts --local    this machine only, into dist/tmb[.exe]
//   bun scripts/build.ts linux-x64  only the named targets
// With TMB_VERSION set, the binary reports that version instead of package.json's.
// It builds through Bun.build rather than `bun build`, so the dashboard's styles go through Tailwind.
import tailwind from "bun-plugin-tailwind";
import { spawnSync } from "node:child_process";
import path from "node:path";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];
const root = path.resolve(import.meta.dir, "..");

function gitSha(): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

async function compile(outfile: string, target?: string): Promise<void> {
  const define: Record<string, string> = { TMB_GIT_SHA: JSON.stringify(sha) };
  if (tmbVersion) define.TMB_VERSION = JSON.stringify(tmbVersion);
  const result = await Bun.build({
    entrypoints: [path.join(root, "src", "cli", "index.ts")],
    compile: { outfile: path.join(root, outfile), ...(target ? { target: `bun-${target}` as Bun.Build.CompileTarget } : {}) },
    minify: true,
    define,
    plugins: [tailwind],
    throw: false,
  });
  for (const log of result.logs) console.error(log);
  if (!result.success) throw new Error(`build failed for ${target ?? "this machine"}`);
}

const sha = gitSha();
// Set by CI to the dev version from scripts/dev-version.ts; unset builds keep the package.json version.
const tmbVersion = process.env.TMB_VERSION?.trim();
const args = process.argv.slice(2);

if (args.includes("--local")) {
  await compile(path.join("dist", process.platform === "win32" ? "tmb.exe" : "tmb"));
} else {
  const unknown = args.filter((t) => !TARGETS.includes(t));
  if (unknown.length > 0) throw new Error(`unknown targets: ${unknown.join(", ")}; known: ${TARGETS.join(", ")}`);
  for (const target of args.length > 0 ? args : TARGETS) {
    await compile(path.join("dist", `tmb-${target}${target.startsWith("windows") ? ".exe" : ""}`), target);
  }
}
