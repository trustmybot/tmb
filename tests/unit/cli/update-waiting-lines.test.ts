// `tmb update` says which sessions stay on an old build: one line for a session alone, one
// counted line for several that wait in the same project, on the same build, for the same reason.
import { expect, setDefaultTimeout, test } from "bun:test";
import { waitingLines } from "../../../src/cli/commands/update.ts";

setDefaultTimeout(30_000);

const lease = (pid: number, project: string, title: string | null = null) => ({ pid, project, startedAt: "2026-01-02T03:04:05.000Z", build: "1.0.0-dev.1", title });
const NEXT_CALL = "it moves at its next tool call";
const OPEN_TASK = "a task is open there; it moves once the task closes";

test("a session alone is named by its title and start time", () => {
  const lines = waitingLines([{ lease: lease(1, "/p", "Bro"), reason: NEXT_CALL }]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith('The session in /p ("Bro", started ');
  expect(lines[0]).toEndWith("stays on 1.0.0-dev.1: it moves at its next tool call.");
});

test("several sessions that wait alike in one project are one counted line", () => {
  const waiting = [1, 2, 3].map((pid) => ({ lease: lease(pid, "/p"), reason: NEXT_CALL }));
  expect(waitingLines(waiting)).toEqual(["3 sessions in /p stay on 1.0.0-dev.1: they move at their next tool call."]);
});

test("another project or another reason is its own line", () => {
  const lines = waitingLines([
    { lease: lease(1, "/p"), reason: OPEN_TASK },
    { lease: lease(2, "/p"), reason: OPEN_TASK },
    { lease: lease(3, "/q"), reason: NEXT_CALL },
  ]);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe("2 sessions in /p stay on 1.0.0-dev.1: a task is open there; they move once the task closes.");
  expect(lines[1]).toStartWith("The session in /q (started ");
});
