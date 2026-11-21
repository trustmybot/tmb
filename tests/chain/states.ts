// The chain's saved states. Before every step the chain saves the world as it stands: the HOME
// with tmb installed, the project with its record, and the bare remotes. A step can then run alone
// from its state, or the chain run on from it, with the same prompts and the same checks.
//
// A state holds absolute paths (git's remotes, the push hooks, the record's repo folders), so it
// opens only in a work folder at the same path it was saved in. The container's is always
// /out/work, so a state the container saved opens in any later container run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** What a state holds: the world's folders that the steps change. */
export const STATE_PARTS = ["home", "todo", "remotes"];

export type StateIndex = {
  /** The work folder the states were saved in, and must be opened in. */
  work: string;
  /** The tmb that made them. */
  version: string;
  /** Each state by step: the state before that step ran. */
  steps: Record<string, { name: string; saved: string; file: string; ran: number[] }>;
};

const INDEX = "index.json";

export function stateFile(states: string, step: number): string {
  return path.join(states, `before-step-${String(step).padStart(2, "0")}.tar.gz`);
}

export function readIndex(states: string): StateIndex | null {
  const file = path.join(states, INDEX);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as StateIndex) : null;
}

/** Saves the state of `work` before step `step` into `states`; `ran` lists the steps the state is the outcome of. */
export function saveState(work: string, states: string, step: { n: number; name: string }, version: string, ran: number[]): string {
  mkdirSync(states, { recursive: true });
  const file = stateFile(states, step.n);
  const parts = STATE_PARTS.filter((part) => existsSync(path.join(work, part)));
  tar(["-czf", file, "-C", work, ...parts]);
  const index = readIndex(states);
  const kept: StateIndex = index && index.work === work ? index : { work, version, steps: {} };
  kept.version = version;
  kept.steps[String(step.n)] = { name: step.name, saved: new Date().toISOString(), file: path.basename(file), ran };
  writeFileSync(path.join(states, INDEX), `${JSON.stringify(kept, null, 2)}\n`);
  return file;
}

/**
 * Puts `work` back as it was before step `step`: its saved folders replace the current ones.
 * Throws when there is no such state, or it was saved in a work folder at another path.
 */
export function openState(work: string, states: string, step: number): StateIndex["steps"][string] {
  const index = readIndex(states);
  if (index === null) throw new Error(`no saved states in ${states}`);
  if (index.work !== work) throw new Error(`the states in ${states} were saved in ${index.work} and open only there; run with --work ${index.work}`);
  const entry = index.steps[String(step)];
  if (!entry) throw new Error(`no state before step ${step} in ${states}; saved: before ${Object.keys(index.steps).map((n) => `step ${n}`).join(", ")}`);
  for (const part of STATE_PARTS) rmSync(path.join(work, part), { recursive: true, force: true });
  tar(["-xzf", path.join(states, entry.file), "-C", work]);
  return entry;
}

function tar(args: string[]): void {
  // macOS's tar would add a ._ file beside each file with extended attributes.
  const result = spawnSync("tar", args, { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (result.status !== 0) throw new Error(`tar ${args.join(" ")}: ${result.stderr || result.error?.message}`);
}
