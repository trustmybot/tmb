// The chained test: one record, the steps in order, the two checks after every step.
//
//   bun tests/chain/run.ts [--work <dir>] [--tmb-file <binary>] [--with-model]
//
// --work       the work folder (a new one under the temp folder when not given). It must be
//              outside any git repo, as a person's project would be.
// --tmb-file   the tmb binary to release and install; built from this checkout when not given.
// --with-model run the session steps too; they need the model login in the environment.
//
// Without --with-model only the steps that use no model run. The chain stops at the first step
// that fails; its logs stay in <work>/logs. Exits 0 when every step it ran passed.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { afterStep, Checks, type Step, StepStopped } from "./chain.ts";
import { buildDemoApp } from "./demo.ts";
import { assetName, buildTmb, chainVersions, publishDev, startReleaseServer } from "./release.ts";
import { SETUP_STEPS } from "./steps/setup.ts";
import { World } from "./world.ts";

export const STEPS: Step[] = [...SETUP_STEPS];

const { values } = parseArgs({
  options: {
    work: { type: "string" },
    "tmb-file": { type: "string" },
    "with-model": { type: "boolean", default: false },
  },
});

const work = path.resolve(values.work ?? mkdtempSync(path.join(tmpdir(), "tmb-chain-")));
const world = new World(work);
world.prepare();
console.log(`The chain's work folder: ${work}`);

const { first } = chainVersions();
let binary = values["tmb-file"];
if (!binary) {
  binary = path.join(work, "build", "tmb");
  console.log(`Building tmb ${first} from this checkout…`);
  await buildTmb(first, binary, null);
}
if (!existsSync(binary)) throw new Error(`no tmb binary at ${binary}`);
const releaseDir = path.join(work, "release");
publishDev(releaseDir, binary, first, assetName(process.platform, process.arch));
const server = await startReleaseServer(releaseDir);
world.releasesUrl = server.url;
buildDemoApp(world);

const withModel = values["with-model"];
let failed = 0;
let fixed = 0;
let ran = 0;
for (const step of STEPS) {
  const label = `step ${step.n}`;
  if (step.model && !withModel) {
    console.log(`SKIP ${label}: ${step.name} (uses the model; run with --with-model)`);
    continue;
  }
  console.log(`\n== ${label}: ${step.name}${step.covers.length ? ` (covers ${step.covers.map((n) => `trustmybot/tmb#${n}`).join(", ")})` : ""}`);
  const checks = new Checks(label);
  const started = performance.now();
  try {
    await step.run(world, checks);
  } catch (error) {
    if (!(error instanceof StepStopped)) checks.ok("the step ran to its end", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  try {
    afterStep(world, checks);
  } catch (error) {
    checks.ok("the checks after the step ran", false, error instanceof Error ? error.message : String(error));
  }
  ran++;
  fixed += checks.fixed;
  console.log(`-- ${label}: ${checks.failures === 0 ? "passed" : `${checks.failures} check(s) failed`} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  if (checks.failures > 0) {
    failed++;
    console.log(`\nThe chain stops at ${label}. Logs: ${world.logs}`);
    break;
  }
}
server.stop();
console.log(`\n${ran} step(s) ran, ${failed === 0 ? "all passed" : "one failed"}${fixed ? `; ${fixed} known check(s) now pass` : ""}.`);
process.exit(failed === 0 ? 0 : 1);
