// The chain's saved states: one opens to the folders as they were saved, and only at its own path.
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openState, readIndex, saveState } from "./states.ts";

setDefaultTimeout(30_000);

function workFolder(): string {
  const work = mkdtempSync(path.join(tmpdir(), "chain-states-"));
  for (const part of ["home", "todo", "remotes"]) mkdirSync(path.join(work, part));
  return work;
}

test("a state opens to the folders as they were before the step, and records what ran", () => {
  const work = workFolder();
  const states = path.join(work, "states");
  writeFileSync(path.join(work, "todo", "record"), "before step 2");
  saveState(work, states, { n: 2, name: "doctor" }, "0.1.0-dev.1", [0, 1]);
  writeFileSync(path.join(work, "todo", "record"), "after step 2");
  writeFileSync(path.join(work, "home", "left-by-step-2"), "");

  const entry = openState(work, states, 2);
  expect(readFileSync(path.join(work, "todo", "record"), "utf8")).toBe("before step 2");
  expect(existsSync(path.join(work, "home", "left-by-step-2"))).toBe(false);
  expect(entry.ran).toEqual([0, 1]);
  expect(readIndex(states)?.work).toBe(work);
});

test("a state opens only in the work folder it was saved in, and names it", () => {
  const work = workFolder();
  const states = path.join(work, "states");
  saveState(work, states, { n: 0, name: "install" }, "0.1.0-dev.1", []);
  expect(() => openState(workFolder(), states, 0)).toThrow(`run with --work ${work}`);
  expect(() => openState(work, states, 3)).toThrow("no state before step 3");
});
