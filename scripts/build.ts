// Compiles the tmb executable with Bun.
//   bun scripts/build.ts            every release target into dist/tmb-<os>-<arch>[.exe]
//   bun scripts/build.ts --local    this machine only, into dist/tmb[.exe]
//   bun scripts/build.ts linux-x64  only the named targets
import { spawnSync } from "node:child_process";
import path from "node:path";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];
const root = path.resolve(import.meta.dir, "..");

function gitSha(): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function compile(outfile: string, target?: string): void {
  const args = ["build", "--compile", "--minify", `--define`, `TMB_GIT_SHA=${JSON.stringify(sha)}`, "src/cli.ts", "--outfile", outfile];
  if (target) args.push(`--target=bun-${target}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", timeout: 600_000 });
  if (result.status !== 0) throw new Error(`build failed for ${target ?? "this machine"}`);
}

const sha = gitSha();
const args = process.argv.slice(2);

if (args.includes("--local")) {
  compile(path.join("dist", process.platform === "win32" ? "tmb.exe" : "tmb"));
} else {
  const unknown = args.filter((t) => !TARGETS.includes(t));
  if (unknown.length > 0) throw new Error(`unknown targets: ${unknown.join(", ")}; known: ${TARGETS.join(", ")}`);
  for (const target of args.length > 0 ? args : TARGETS) {
    compile(path.join("dist", `tmb-${target}${target.startsWith("windows") ? ".exe" : ""}`), target);
  }
}
