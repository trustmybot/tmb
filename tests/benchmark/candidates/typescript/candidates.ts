// The candidate tools for way B in TypeScript and JavaScript (trustmybot/tmb#338), and the means
// to build a graph with each. Research only: nothing in src/ names a candidate.
//
// Every candidate is a LanguageTool (src/engine/graph/languages/contract.ts). The nodes are the
// built-in parser's, the same for every candidate; a candidate only answers what each call
// resolves to, matched to the nodes by place (CODE_GRAPH.md, "Two ways to make links").
import { javascript, tsx, typescript } from "../../../../src/engine/graph/languages/typescript/index.ts";
import { typescriptCompiler } from "../../../../src/engine/graph/languages/typescript/tool.ts";
import type { LanguageTool, ToolAnswer, ToolCall, ToolNode } from "../../../../src/engine/graph/languages/contract.ts";
import { typescript7, typescript7Strict59 } from "./ts7.ts";

export type Candidate = { id: string; label: string; tool: LanguageTool };

export const CANDIDATES: readonly Candidate[] = [
  { id: "ts5", label: "TypeScript 5.9 (carried, JavaScript API): way B today", tool: typescriptCompiler },
  { id: "ts7", label: "TypeScript 7 (native, Go; its API)", tool: typescript7 },
  { id: "ts7-control", label: "TypeScript 7, control: `strict` off by default, as in TypeScript 5.9", tool: typescript7Strict59 },
];

/** What a tool was given and answered in one build: the nodes, the calls, and an answer per call. */
export type Recorded = { nodes: ToolNode[]; calls: ToolCall[]; answers: ToolAnswer[]; ms: { open: number; answer: number } };

/** A tool that records what it is given and what it answers, and how long it takes. */
export function recording(tool: LanguageTool, into: { value: Recorded | null }): LanguageTool {
  return {
    name: tool.name,
    open(repoDir: string) {
      const t = performance.now();
      const opened = tool.open(repoDir);
      const openMs = performance.now() - t;
      if ("unavailable" in opened) return opened;
      return {
        answer(input) {
          const t2 = performance.now();
          const answers = opened.answer(input);
          into.value = { nodes: [...input.nodes], calls: [...input.calls], answers, ms: { open: openMs, answer: performance.now() - t2 } };
          return answers;
        },
      };
    },
  };
}

const MODULES = [typescript, tsx, javascript];

/** Runs `use` with every TypeScript and JavaScript module's tool set to `tool`, then puts the carried compiler back. */
export async function withTool<T>(tool: LanguageTool, use: () => Promise<T>): Promise<T> {
  const before = MODULES.map((m) => m.tool);
  for (const m of MODULES) m.tool = tool;
  try {
    return await use();
  } finally {
    MODULES.forEach((m, i) => {
      m.tool = before[i];
    });
  }
}
