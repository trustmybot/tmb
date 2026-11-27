// The benchmark's second judge of Python's links (trustmybot/tmb#427): Jedi, which is not pyright.
// pyright is way B's source and the reference, so it cannot judge way B's links (CODE_GRAPH.md,
// Benchmark detail); Jedi judges them. python_judge.py asks Jedi "go to definition" at each place,
// set up as the reference sets pyright up: no installed package, a `src` layout looked for, and no
// guess. Jedi is installed by the test setup at its pin (tests/lib/pinned-tools.ts).
//
// Jedi runs on Python 3.10 or later. It runs with TMB_JUDGE_PYTHON when that names an interpreter,
// else with `python3` on PATH; one older than Jedi needs is an error that says so.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { installJedi, JEDI } from "../lib/pinned-tools.ts";
import type { Declaration, LspPosition } from "./python_checker.ts";

/** The judge's name and version, for the scores' notes. */
export const JUDGE = `Jedi ${JEDI.version}`;

const SCRIPT = path.join(import.meta.dir, "python_judge.py");

/** The interpreter the judge runs with. */
export const judgePython = (): string => process.env.TMB_JUDGE_PYTHON ?? "python3";

/** Why the interpreter cannot run Jedi, or null when it can. */
export function judgeCannotRun(python = judgePython()): string | null {
  const run = spawnSync(python, ["-I", "-c", "import sys; print('%d %d' % sys.version_info[:2])"], { encoding: "utf8" });
  if (run.error !== undefined || run.status !== 0) return `no ${python} to run ${JUDGE}`;
  const [major, minor] = run.stdout.trim().split(" ").map(Number) as [number, number];
  const { major: needMajor, minor: needMinor } = JEDI.python;
  if (major < needMajor || (major === needMajor && minor < needMinor)) return `${JUDGE} needs Python ${needMajor}.${needMinor} or later; ${python} is ${major}.${minor} (set TMB_JUDGE_PYTHON)`;
  return null;
}

/**
 * Jedi's declarations for the name written at each place asked, in order: null when it names none.
 * `files` are the repo's Python files at the commit, by path from `root`, whose working tree is at
 * the commit; `asked` are the places, a file and a position.
 */
export async function judgeDeclarations(root: string, files: ReadonlyMap<string, string>, asked: readonly { file: string; at: LspPosition }[]): Promise<(Declaration[] | null)[]> {
  const python = judgePython();
  const why = judgeCannotRun(python);
  if (why !== null) throw new Error(why);
  const jedi = await installJedi(python);
  const rootDir = path.resolve(root);
  const request = { jedi, cache: path.join(path.dirname(jedi), `jedi-${JEDI.version}-cache`), root: rootDir, files: Object.fromEntries(files), asked: asked.map((q) => [q.file, q.at.line, q.at.character]) };
  // -S: no site-packages on the path, so Jedi reads no installed package.
  const run = spawnSync(python, ["-I", "-S", SCRIPT], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (run.error !== undefined || run.status !== 0) throw new Error(`${python} ${SCRIPT} failed: ${run.error?.message ?? run.stderr}`);
  const { answers } = JSON.parse(run.stdout) as { answers: ([string, number, number, number][] | null)[] };
  return answers.map((a) => (a === null ? null : a.map(([file, line, start, end]): Declaration => ({ file, start: { line, character: start }, end: { line, character: end } }))));
}
