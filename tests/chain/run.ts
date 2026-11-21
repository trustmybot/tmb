// The chained test: one record, the steps in order, the two checks after every step.
//
//   bun tests/chain/run.ts [--work <dir>] [--tmb-file <binary>] [--with-model]
//                          [--from <step> | --only <step>] [--states <dir>]
//
// --work       the work folder (a new one under the temp folder when not given). It must be
//              outside any git repo, as a person's project would be.
// --tmb-file   the tmb binary to release and install; built from this checkout when not given.
// --with-model run the session steps too; they need the model login in the environment.
// --from       open the state saved before this step and run the chain on from it.
// --only       open the state saved before this step and run only this step.
// --states     where states are saved and opened: <work>/states by default. With --from or
//              --only and no --work, the work folder is the one the states were saved in.
//
// Without --with-model only the steps that use no model run. A state is saved before every step
// that runs. The chain stops at the first step that fails; its logs stay in <work>/logs. Exits 0
// when every step it ran passed.
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { afterStep, Checks, type Step, StepStopped } from "./chain.ts";
import { buildDemoApp } from "./demo.ts";
import { assetName, buildTmb, chainVersions, publishDev, startReleaseServer } from "./release.ts";
import { openState, readIndex, saveState, STATE_PARTS } from "./states.ts";
import { SETUP_STEPS } from "./steps/setup.ts";
import { World } from "./world.ts";

export const STEPS: Step[] = [...SETUP_STEPS];

const { values } = parseArgs({
  options: {
    work: { type: "string" },
    "tmb-file": { type: "string" },
    "with-model": { type: "boolean", default: false },
    from: { type: "string" },
    only: { type: "string" },
    states: { type: "string" },
  },
});

if (values.from !== undefined && values.only !== undefined) throw new Error("give --from or --only, not both");
const opened = values.from ?? values.only;
const startAt = opened === undefined ? null : Number(opened);
if (startAt !== null && !STEPS.some((step) => step.n === startAt)) throw new Error(`no step ${opened}; the steps are ${STEPS.map((step) => step.n).join(", ")}`);
const savedWork = values.states && !values.work && startAt !== null ? readIndex(path.resolve(values.states))?.work : undefined;
const work = path.resolve(values.work ?? savedWork ?? mkdtempSync(path.join(tmpdir(), "tmb-chain-")));
const states = path.resolve(values.states ?? path.join(work, "states"));
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
let openedRan: number[] = [];
if (startAt === null) {
  for (const part of [...STATE_PARTS, "logs"]) rmSync(path.join(work, part), { recursive: true, force: true });
  world.prepare();
  buildDemoApp(world);
} else {
  const entry = openState(work, states, startAt);
  openedRan = entry.ran;
  console.log(`Opened the state saved ${entry.saved} before step ${startAt} (${entry.name}), the outcome of steps ${entry.ran.join(", ") || "none"}.`);
  // The build under test takes the place of the tmb the state was saved with, as an update
  // would: it opens the older record through its normal upgrade.
  if (existsSync(world.installed)) {
    copyFileSync(binary, world.installed);
    chmodSync(world.installed, 0o755);
  }
}

const withModel = values["with-model"];
let failed = 0;
let fixed = 0;
let ran = 0;
const done: number[] = [...openedRan];
const chosen = STEPS.filter((step) => startAt === null || (values.only !== undefined ? step.n === startAt : step.n >= startAt));
for (const step of chosen) {
  const label = `step ${step.n}`;
  if (step.model && !withModel) {
    console.log(`SKIP ${label}: ${step.name} (uses the model; run with --with-model)`);
    continue;
  }
  // The state a step was opened from is kept as it was saved.
  if (step.n !== startAt) saveState(work, states, step, first, done);
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
  done.push(step.n);
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
