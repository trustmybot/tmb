// TypeScript 7, the native compiler, as a candidate tool for way B (trustmybot/tmb#338). Research
// only: nothing in src/ uses it. It is a LanguageTool (src/engine/graph/languages/contract.ts), so
// the benchmark builds and scores its graph exactly as it does the carried TypeScript 5.9's.
//
// tmb installs nothing, and neither does this harness: the TypeScript 7 package is installed by
// whoever runs the A/B test, outside the repo, and named by TMB_CANDIDATE_TS7 (the folder of the
// `typescript` package, version 7). Its synchronous API runs under Node only (ts7-bridge.mjs says
// why), so each answer runs the bridge with Node.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LanguageTool, ToolAnswer, ToolInput } from "../../../../src/engine/graph/languages/contract.ts";

/** The variable naming the TypeScript 7 package's folder. */
export const TS7_ENV = "TMB_CANDIDATE_TS7";

const BRIDGE = path.join(import.meta.dir, "ts7-bridge.mjs");

/** The TypeScript 7 package's folder, or why there is none. */
export function ts7Package(): { folder: string; version: string } | { unavailable: string } {
  const folder = process.env[TS7_ENV]?.trim();
  if (!folder) return { unavailable: `${TS7_ENV} is not set to the folder of the typescript@7 package` };
  const manifest = path.join(folder, "package.json");
  if (!existsSync(manifest)) return { unavailable: `${folder} has no package.json` };
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  if (!version.startsWith("7.")) return { unavailable: `${folder} holds typescript ${version}, not 7` };
  return { folder, version };
}

/** What one run of the bridge took, in milliseconds: the program opened, and the calls answered. */
export type Ts7Timing = { open: number; answer: number; process: number };

/** The timing of the last answer, for the A/B report. */
export const lastTs7Timing: { value: Ts7Timing | null } = { value: null };

/**
 * The TypeScript 7 compiler, asked through its own API, with tool.ts's per-call rule. `baseOptions`
 * are laid over tool.ts's base options and under the project's own (ts7-bridge.mjs).
 */
export const typescript7With = (baseOptions: Record<string, unknown> = {}): LanguageTool => ({
  name: "the TypeScript 7 compiler",
  open(repoDir: string) {
    const pkg = ts7Package();
    if ("unavailable" in pkg) return pkg;
    return {
      answer(input: ToolInput): ToolAnswer[] {
        const scratch = mkdtempSync(path.join(tmpdir(), "tmb-ts7-"));
        try {
          const inFile = path.join(scratch, "input.json");
          const outFile = path.join(scratch, "output.json");
          writeFileSync(
            inFile,
            JSON.stringify({ root: path.resolve(repoDir), files: Object.fromEntries(input.files), configs: Object.fromEntries(input.configs), nodes: input.nodes, calls: input.calls }),
          );
          const t = performance.now();
          const run = spawnSync("node", [BRIDGE, pkg.folder, inFile, outFile, JSON.stringify(baseOptions)], { encoding: "utf8", stdio: ["ignore", "inherit", "pipe"] });
          const processMs = performance.now() - t;
          if (run.status !== 0) throw new Error(`the TypeScript 7 bridge failed (${run.status}): ${run.stderr.slice(-2000)}`);
          const out = JSON.parse(readFileSync(outFile, "utf8")) as { answers: ToolAnswer[]; timing: { open: number; answer: number } };
          lastTs7Timing.value = { ...out.timing, process: processMs };
          if (out.answers.length !== input.calls.length) throw new Error(`the TypeScript 7 bridge gave ${out.answers.length} answers for ${input.calls.length} calls`);
          return out.answers;
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
    };
  },
});

export const typescript7 = typescript7With();

/**
 * TypeScript 6 made `strict` on by default; TypeScript 5.9 has it off. The control run gives
 * TypeScript 7 TypeScript 5.9's default, so a difference left is the compiler's, not a default's.
 */
export const typescript7Strict59 = typescript7With({ strict: false });
