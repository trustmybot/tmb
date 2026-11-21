// The worker runs a failed start left open (trustmybot/tmb#285), kept apart as a known hole.
import { expect, setDefaultTimeout, test } from "bun:test";
import { type RunRow, strandedRuns } from "./record.ts";

setDefaultTimeout(30_000);

const run = (id: string, task: string | null, ended: boolean, role = "worker"): RunRow => ({
  id,
  task_id: task,
  feature_id: null,
  role,
  started_at: "2026-11-21T08:14:45.677Z",
  ended_at: ended ? "2026-11-21T08:15:48.694Z" : null,
  outcome: ended ? "finished" : null,
  cost: ended ? "[]" : null,
  created_by: "{}",
});

test("two worker runs on one task, neither ended, are the failed start's", () => {
  expect(strandedRuns([run("a", "T1", false), run("b", "T1", false)]).map((each) => each.id)).toEqual(["a", "b"]);
});

test("one open worker run, a run that ended beside it, or a reviewer run is not", () => {
  expect(strandedRuns([run("a", "T1", false)])).toEqual([]);
  expect(strandedRuns([run("a", "T1", false), run("b", "T1", true)])).toEqual([]);
  expect(strandedRuns([run("a", null, false, "reviewer"), run("b", null, false, "reviewer")])).toEqual([]);
  expect(strandedRuns([run("a", "T1", false), run("b", "T2", false)])).toEqual([]);
});
