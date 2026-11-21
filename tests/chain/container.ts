// Runs the chain in one empty Linux container, under Docker or Podman:
//
//   bun tests/chain/container.ts [--out <dir>] [--with-model] [--from <step> | --only <step>]
//
// Builds tmb for Linux on this machine's CPU, builds the image from tests/chain/Dockerfile, and
// runs tests/chain/run.ts in the container with the checkout mounted read-only. The work folder
// and its logs land in <out>/work. <out> is a new folder under ~/.cache/tmb-chain by default: the
// Linux VM that runs Colima or a Podman machine on a Mac shares only the home folder. With --with-model the session steps run too; the model login
// (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY) is passed through from this environment by name,
// so its value is never written in a command line, the image or a saved state.
// --from and --only open the state saved before that step by an earlier run into the same --out,
// as tests/chain/run.ts says. TMB_CHAIN_ENGINE picks docker or podman; the first found is used otherwise.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildTmb, chainVersions, ROOT } from "./release.ts";

const IMAGE = "tmb-chain";
const LOGINS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "with-model": { type: "boolean", default: false },
    from: { type: "string" },
    only: { type: "string" },
  },
});

const engine = process.env.TMB_CHAIN_ENGINE ?? ["docker", "podman"].find((name) => Bun.which(name) !== null);
if (!engine) {
  console.error("The chain's container needs Docker or Podman, and neither is on the PATH.");
  process.exit(2);
}
const cache = path.join(homedir(), ".cache", "tmb-chain");
mkdirSync(cache, { recursive: true });
const out = path.resolve(values.out ?? mkdtempSync(path.join(cache, "run-")));
mkdirSync(out, { recursive: true });

function must(command: string, args: string[]): void {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const target = `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
const { first, next } = chainVersions();
console.log(`Building tmb ${first}, and ${next} for the update step, for ${target}…`);
await buildTmb(first, path.join(out, "tmb-linux"), target);
await buildTmb(next, path.join(out, "tmb-linux-next"), target);

must(engine, ["build", "--tag", IMAGE, "--file", path.join(import.meta.dir, "Dockerfile"), import.meta.dir]);

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const withModel = values["with-model"];
const run = [
  "run",
  "--rm",
  "--user",
  `${uid}:${gid}`,
  ...(engine.endsWith("podman") ? ["--userns=keep-id"] : []),
  "--env",
  "HOME=/tmp",
  ...(withModel ? [...LOGINS, "TMB_CHAIN_MODEL"].filter((name) => process.env[name]).flatMap((name) => ["--env", name]) : []),
  "--volume",
  `${ROOT}:/src:ro`,
  "--volume",
  `${out}:/out`,
  IMAGE,
  "bun",
  "/src/tests/chain/run.ts",
  "--work",
  "/out/work",
  "--tmb-file",
  "/out/tmb-linux",
  "--tmb-next-file",
  "/out/tmb-linux-next",
  ...(withModel ? ["--with-model"] : []),
  ...(values.from !== undefined ? ["--from", values.from] : []),
  ...(values.only !== undefined ? ["--only", values.only] : []),
];
console.log(`$ ${engine} ${run.join(" ")}`);
const result = spawnSync(engine, run, { stdio: "inherit" });
console.log(`The chain's logs: ${path.join(out, "work", "logs")}`);
process.exit(result.status ?? 1);
