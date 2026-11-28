// `tmb feedback`: the Human drafts a bug report about tmb itself, reads it whole, and says yes
// or no to sending it; `tmb feedback on|off|status` changes or shows the setting. Without a
// terminal a report is only written to a file. The command works whether the program is on or
// off: off only stops the planner from offering one.
import { type Actor, channelFor, draftReport, draftText, type FeedbackEnv, feedbackExplanation, openProjectStore, projectRootOf, recentLastError, routeLine, sendDraft, setFeedback, statusOf, type Store } from "../../engine/index.ts";

const HUMAN: Actor = { kind: "human" };

export const FEEDBACK_USAGE = `  tmb feedback [<text>]     Draft a bug report about tmb itself, show it whole and ask before
                            sending it to tmb's repo as a public issue; <text> says what you
                            were doing. Without a terminal, only writes the draft to a file
  tmb feedback on|off|status
                            Join or leave the feedback program, or show whether it is on`;

export type FeedbackIo = {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Asks on the terminal; null when there is none. */
  ask: ((prompt: string) => Promise<string | null>) | null;
  cwd: string;
};

const YES = /^\s*(y|yes)\s*$/i;
const SUMMARY_MAX = 120;

function statusLine(env: FeedbackEnv): string {
  const status = statusOf(env);
  const state = status.on ? "on" : "off";
  const why =
    status.reason === "setting"
      ? "as you set it"
      : status.reason === "default"
        ? `the ${status.channel} channel's default`
        : `${status.reason}=1 turns it off${status.state.setting === "on" ? ", though the setting is on" : ""}`;
  return `The feedback program is ${state} for ${env.program.name} (${why}).`;
}

/** The first sentence of `text`, cut short when long. */
function summaryOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length <= SUMMARY_MAX ? sentence : `${sentence.slice(0, SUMMARY_MAX - 1)}…`;
}

function openRecord(projectDir: string): Store | null {
  try {
    const opened = openProjectStore(projectDir, { create: false });
    return opened.ok ? opened.store : null;
  } catch {
    return null;
  }
}

export async function runFeedbackCommand(args: string[], env: FeedbackEnv, io: FeedbackIo): Promise<number> {
  const flags = args.filter((arg) => arg.startsWith("-"));
  if (flags.length > 0) {
    io.err(`${env.program.name} feedback takes no flags, got ${flags.join(" ")}`);
    return 2;
  }
  const [first, ...rest] = args;
  if (first === "on" || first === "off" || first === "status") {
    if (rest.length > 0) {
      io.err(`${env.program.name} feedback ${first} takes no arguments, got ${rest.join(" ")}`);
      return 2;
    }
    if (first !== "status") setFeedback(env.stateDir, channelFor(env), first, env.now());
    io.out(statusLine(env));
    if (first === "status") for (const line of feedbackExplanation(env)) io.out(line);
    return 0;
  }
  return draftAndAsk(args.join(" ").trim(), env, io);
}

async function draftAndAsk(given: string, env: FeedbackEnv, io: FeedbackIo): Promise<number> {
  let text = given;
  if (text === "" && io.ask !== null) text = ((await io.ask("What were you doing when tmb went wrong? ")) ?? "").trim();
  const lastError = recentLastError(env.stateDir, env.now());
  const summary = text !== "" ? summaryOf(text) : lastError !== null ? summaryOf(lastError.message.split("\n")[0] ?? "") : "tmb went wrong";
  const projectDir = projectRootOf(io.cwd);
  const store = openRecord(projectDir);
  try {
    const draft = await draftReport(
      env,
      {
        summary,
        whatHappened: text !== "" ? text : "Not given.",
        command: lastError === null ? null : `tmb ${lastError.command}`,
        error: lastError === null ? null : [`The last error tmb gave on this machine, at ${lastError.at}:`, lastError.message, lastError.stack ?? ""].filter((part) => part !== "").join("\n"),
      },
      { store, projectDir },
    );
    io.out(draftText(draft));
    io.out("");
    if (draft.form.source === "built-in copy") io.out(`tmb could not read the bug form from ${env.repo.owner}/${env.repo.name} (${draft.form.fallbackReason}); it used the copy built into it.`);
    io.out(`The draft is saved at ${draft.file}.`);
    if (io.ask === null) {
      io.out(`No terminal to ask on, so nothing was sent. Run ${env.program.name} feedback on a terminal to send a report.`);
      return 0;
    }
    io.out(routeLine(env).line);
    const answer = await io.ask("Send this report? It becomes public; yes confirms you read it and it holds no secrets, private code or personal paths. [y/N] ");
    if (answer === null || !YES.test(answer)) {
      io.out("Nothing was sent.");
      return 0;
    }
    let result;
    try {
      result = sendDraft(env, draft, store === null ? null : { store, actor: HUMAN });
    } catch (error) {
      io.err(`GitHub did not take the report: ${error instanceof Error ? error.message : String(error)}. The draft is kept at ${draft.file}.`);
      return 1;
    }
    if (result.route === "issue") {
      io.out(`Filed: ${result.url}`);
      return 0;
    }
    io.out(result.opened ? "The filled-in form is open in your browser: press submit there to file it." : `Open this link to file the report, and press submit there:\n${result.url}`);
    if (result.shortened) io.out(`The report is too long for a link: attach ${result.file} to the form.`);
    return 0;
  } finally {
    store?.close();
  }
}
