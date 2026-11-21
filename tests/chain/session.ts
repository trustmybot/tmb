// A session a user has with bro: one `claude -p` run in the project, with tmb's hooks and tools,
// as a new session each time, or a later turn of the same session. No one is there to answer, so
// it runs in tmb's unattended mode. The login comes from the environment (CLAUDE_CODE_OAUTH_TOKEN
// or ANTHROPIC_API_KEY); the chain never reads it.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { World } from "./world.ts";

/**
 * The model the sessions run: TMB_CHAIN_MODEL, or Claude Code's own default, the one a user
 * gets (#260, decision 5). Workers and the reviewer run the model their role file names.
 */
export const MODEL = process.env.TMB_CHAIN_MODEL || null;

/**
 * What bro's session may use with no one to approve a prompt: tmb's tools, the subagent tool
 * (Agent, or Task in older Claude Code), the file tools and Bash. Every call still goes through
 * tmb's hooks; nothing here bypasses them.
 */
export const SESSION_TOOLS = "mcp__tmb__* Agent Task Read Glob Grep Edit Write Bash";

/** How long one turn may take before the chain stops it. */
const TURN_TIMEOUT_MS = 40 * 60_000;

export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
export type Turn = {
  status: number;
  /** bro's last answer. */
  answer: string;
  /** The session, for a later turn of it. */
  sessionId: string;
  usage: Usage;
  isError: boolean;
  log: string;
  /** How the turn went, for a check's detail. */
  shown: string;
};

/** The prompt a step sends, as the Human wrote it in tests/chain/prompts. */
export function prompt(name: string): string {
  return readFileSync(path.join(import.meta.dir, "prompts", `${name}.txt`), "utf8").replace(/\r?\n$/, "");
}

/**
 * One turn with bro: a new session, or with `resume` the next turn of that one. Its JSON answer
 * is saved to <logs>/<log>.json.
 */
export function askBro(world: World, text: string, log: string, options: { resume?: string } = {}): Turn {
  const args = ["-p", text, "--output-format", "json", "--allowedTools", SESSION_TOOLS];
  if (MODEL) args.push("--model", MODEL);
  if (options.resume) args.push("--resume", options.resume);
  console.log(`   asking bro${options.resume ? " (same session)" : " (new session)"}: ${text}`);
  const result = world.run("claude", args, { env: { TMB_UNATTENDED: "1" }, timeout: TURN_TIMEOUT_MS });
  const file = world.log(`${log}.json`, result.output);
  let parsed: { result?: string; session_id?: string; usage?: Usage; is_error?: boolean } = {};
  try {
    parsed = JSON.parse(result.stdout);
  } catch {}
  const answer = parsed.result ?? "";
  const shown = `claude exited ${result.status}; saved to ${file}\n${answer || result.output.slice(-2000)}`;
  const turn: Turn = { status: result.status, answer, sessionId: parsed.session_id ?? "", usage: parsed.usage ?? {}, isError: parsed.is_error ?? true, log: file, shown };
  taken.push(turn);
  return turn;
}

const taken: Turn[] = [];

/** The turns asked since the last call: the runner prints their tokens after each step. */
export function takeTurns(): Turn[] {
  return taken.splice(0, taken.length);
}

// ---------------------------------------------------------------------------------------------
// Tokens

type ModelCost = { model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
export type RunTokens = { id: string; role: string; outcome: string | null; model: string; input: number; output: number; cacheRead: number; cacheWrite: number };

/** The agent runs tmb's record holds that started at or after `since`, with their tokens. */
export function runsSince(world: World, since: string): RunTokens[] {
  const db = new Database(path.join(world.project, ".tmb", "trajectory.db"), { readonly: true });
  try {
    const rows = db.query("SELECT id, role, outcome, cost FROM runs WHERE started_at >= ? ORDER BY started_at, id").all(since) as { id: string; role: string; outcome: string | null; cost: string | null }[];
    return rows.map((row) => {
      const costs = row.cost ? (JSON.parse(row.cost) as ModelCost[]) : [];
      const sum = (key: keyof ModelCost) => costs.reduce((total, each) => total + Number(each[key] ?? 0), 0);
      return {
        id: row.id,
        role: row.role,
        outcome: row.outcome,
        model: costs.map((each) => each.model).filter(Boolean).join("+") || "-",
        input: sum("inputTokens"),
        output: sum("outputTokens"),
        cacheRead: sum("cacheReadTokens"),
        cacheWrite: sum("cacheWriteTokens"),
      };
    });
  } finally {
    db.close();
  }
}

/** All the tokens a run or a turn used: input, output and cache, as one number for a budget. */
export const totalOf = (run: { input: number; output: number; cacheRead: number; cacheWrite: number }) => run.input + run.output + run.cacheRead + run.cacheWrite;

export function turnTokens(turn: Turn): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const usage = turn.usage;
  return { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 };
}
