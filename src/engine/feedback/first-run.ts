// The first run of a program tells the person about the feedback program once: on dev and rc
// a notice that it is on, on stable a question whether to join, where no answer means off. The
// first run is the end of `tmb init` on a terminal, else the planner at the first session. In a
// run where no one can answer, nothing is said and nothing is marked.
import type { FeedbackEnv } from "./index.ts";
import { channelFor, statusOf } from "./index.ts";
import { firstRunPending, markFirstRun, setFeedback } from "./setting.ts";

/** What a report holds and what it never holds, in a few lines for the person. */
export function feedbackExplanation(env: FeedbackEnv): string[] {
  const repo = `${env.repo.owner}/${env.repo.name}`;
  const name = env.program.name;
  return [
    "When tmb itself breaks, the planner may draft a bug report for tmb's maintainers. You see the whole report and say yes or no to each one; nothing is sent without your yes.",
    `A report becomes a public issue on ${repo} from your GitHub account. It holds tmb's version, your OS, your agent program, the command that failed, the error and tmb's stack, and the kinds of recent record events, with your paths cleaned. It never holds source code, file contents, prompts, agent messages or environment variables.`,
    `Turn it on or off with \`${name} feedback on\` or \`${name} feedback off\`; TMB_NO_FEEDBACK=1 or DO_NOT_TRACK=1 turns it off whatever the setting says. \`${name} feedback\` drafts a report yourself.`,
  ];
}

/** What the first run is still to do: tell (dev, rc) or ask (stable); null when it was done or a switch turned the program off. */
export function pendingFirstRun(env: FeedbackEnv): "notice" | "question" | null {
  const status = statusOf(env);
  if (!firstRunPending(status)) return null;
  return status.on ? "notice" : "question";
}

const YES = /^\s*(y|yes)\s*$/i;

/** The end of `tmb init` on a terminal: the notice, or the question, once per program on this machine. */
export async function firstRunAtInit(env: FeedbackEnv, ask: (prompt: string) => Promise<string | null>, out: (line: string) => void): Promise<void> {
  const pending = pendingFirstRun(env);
  if (pending === null) return;
  const channel = channelFor(env);
  if (pending === "notice") {
    out("");
    out(`The feedback program is on for ${env.program.name}, on the ${channel} channel.`);
    for (const line of feedbackExplanation(env)) out(line);
    markFirstRun(env.stateDir, channel, env.now());
    return;
  }
  out("");
  out(`tmb has a feedback program; on the ${channel} channel it is off unless you join.`);
  for (const line of feedbackExplanation(env)) out(line);
  const answer = await ask("Join the feedback program? [y/N] ");
  const joined = answer !== null && YES.test(answer);
  setFeedback(env.stateDir, channel, joined ? "on" : "off", env.now());
  out(joined ? "You joined the feedback program." : "The feedback program stays off.");
}

export const FEEDBACK_HEADING = "## tmb's feedback program";

/**
 * The planner's first session, when init did not tell or ask on a terminal: what to tell the
 * Human, or ask them, once. Marks the first run as done, so it is said once per program on this
 * machine. Empty when nothing is pending.
 */
export function firstRunSection(env: FeedbackEnv): string {
  const pending = pendingFirstRun(env);
  if (pending === null) return "";
  const channel = channelFor(env);
  const name = env.program.name;
  const explained = feedbackExplanation(env).join(" ");
  const say =
    pending === "notice"
      ? `This is the first session of ${name} on this machine. Tell the Human once, in a few lines, that tmb's feedback program is on for the ${channel} channel: ${explained}`
      : `This is the first session of ${name} on this machine. Ask the Human once whether to join tmb's feedback program, which is off on the ${channel} channel unless they join: ${explained} ` +
        `On a yes, run \`${name} feedback on\`; on a no, \`${name} feedback off\`. No answer leaves it off.`;
  markFirstRun(env.stateDir, channel, env.now());
  return `${FEEDBACK_HEADING}\n\n${say}`;
}
