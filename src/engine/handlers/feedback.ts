// The planner's two feedback tools (trustmybot/tmb#122): one drafts a bug report about tmb
// itself, one sends a draft. The send is refused unless the Human said yes to that draft, and
// in a run where no one can answer nothing is drafted for sending.
import { runningName } from "../program.ts";
import { channelFor, draftReport, draftText, type FeedbackEnv, readDraft, routeLine, sendDraft, statusOf } from "../feedback/index.ts";
import type { Actor, Store } from "../store/index.ts";
import { type OperationContext } from "./common.ts";
import { HandlerError } from "./errors.ts";
import { type InputSchema, NOT_BLANK, validateInput } from "./input.ts";

function feedbackOf(context: OperationContext): FeedbackEnv {
  if (context.feedback === undefined) throw new HandlerError("refused", "the feedback program is not available in this run");
  return context.feedback;
}

/** Refuses when the program is off on this machine: the planner then does not offer a report. */
function requireOn(env: FeedbackEnv, operation: string): void {
  const status = statusOf(env);
  if (status.on) return;
  const why =
    status.reason === "setting" || status.reason === "default"
      ? `it is off for ${env.program.name} on this machine${status.reason === "default" ? ` (the ${channelFor(env)} channel's default)` : ""}`
      : `${status.reason}=1 turns it off`;
  throw new HandlerError("refused", `${operation}: the feedback program is off: ${why}. Do not offer a report; the Human can still run \`${env.program.name} feedback\` themselves.`);
}

// --- feedback_draft -------------------------------------------------------------------

export const feedbackDraftSchema: InputSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One sentence: what went wrong in tmb.", pattern: NOT_BLANK },
    what_happened: {
      type: "string",
      description: "What was being done when tmb broke, in plain words: the Human's, or yours for the Human to edit. No source code, file contents, prompts or messages.",
      pattern: NOT_BLANK,
    },
    command: { type: "string", description: "The tmb command or tool that failed, as `task_close` or `tmb onboard`." },
    error: { type: "string", description: "The error tmb gave, exactly, with tmb's own stack when it showed one." },
  },
  required: ["summary", "what_happened"],
  additionalProperties: false,
};

export type FeedbackDraftResult = {
  draft_id: string;
  /** The whole report, as it will be sent: show all of it to the Human. */
  report: string;
  file: string;
  route: string;
  form: string;
  sendable: boolean;
  next: string;
};

// --- feedback_send --------------------------------------------------------------------

export const feedbackSendSchema: InputSchema = {
  type: "object",
  properties: {
    draft_id: { type: "string", description: "The draft_id feedback_draft returned for the report the Human read.", pattern: NOT_BLANK },
    human_answer: {
      type: "string",
      description: "The Human's answer to sending this draft. Only `yes`, and only after the Human read the whole draft and said yes to it; never your own choice.",
      enum: ["yes"],
    },
  },
  required: ["draft_id", "human_answer"],
  additionalProperties: false,
};

export type FeedbackSendResult = { route: "issue"; url: string; next: string } | { route: "form"; url: string; opened: boolean; next: string };

/** The feedback program's tools for one caller: draft a report, and send one the Human said yes to. */
export class FeedbackService {
  constructor(
    private readonly store: Store,
    private readonly actor: Actor,
    private readonly context: OperationContext,
  ) {}

  async draft(input: unknown): Promise<FeedbackDraftResult> {
    const values = validateInput<{ summary: string; what_happened: string; command?: string; error?: string }>("feedback_draft", feedbackDraftSchema, input);
    const env = feedbackOf(this.context);
    requireOn(env, "feedback_draft");
    const draft = await draftReport(
      env,
      { summary: values.summary, whatHappened: values.what_happened, command: values.command ?? null, error: values.error ?? null },
      { store: this.store, projectDir: this.context.projectDir },
    );
    const form =
      draft.form.source === "default branch"
        ? `It follows ${env.repo.owner}/${env.repo.name}'s bug form as it stands on the default branch.`
        : `tmb could not read ${env.repo.owner}/${env.repo.name}'s bug form (${draft.form.fallbackReason}); it used the copy built into it. Tell the Human so.`;
    if (this.context.unattended === true) {
      return {
        draft_id: draft.id,
        report: draftText(draft),
        file: draft.file,
        route: "none: no one can answer in this run",
        form,
        sendable: false,
        next: `No one can answer in this run, so this draft is only kept as a file and is never sent. Name the file in your answer; the Human can send a report later with \`${env.program.name} feedback\`.`,
      };
    }
    return {
      draft_id: draft.id,
      report: draftText(draft),
      file: draft.file,
      route: routeLine(env).line,
      form,
      sendable: true,
      next:
        "Show the Human the whole report, word for word, and where it goes; it becomes public. Ask whether to send it. " +
        "Offer to change the sentence on what happened, and draft again with their change. Call feedback_send only after their yes to this draft; on a no, send nothing.",
    };
  }

  send(input: unknown): FeedbackSendResult {
    const values = validateInput<{ draft_id: string; human_answer: "yes" }>("feedback_send", feedbackSendSchema, input);
    const env = feedbackOf(this.context);
    if (this.context.unattended === true) throw new HandlerError("refused", `feedback_send: no one can answer in this run, so no report is sent; the Human can send one later with \`${runningName()} feedback\``);
    requireOn(env, "feedback_send");
    const draft = readDraft(env.stateDir, values.draft_id.trim());
    if (draft === null) throw new HandlerError("not_found", `feedback_send: no draft ${values.draft_id}; draft the report with feedback_draft and show it to the Human first`);
    if (draft.sent !== null) throw new HandlerError("refused", `feedback_send: report ${draft.id} was already ${draft.sent.route === "issue" ? `filed: ${draft.sent.url}` : "opened as a form"}`);
    let result;
    try {
      result = sendDraft(env, draft, { store: this.store, actor: this.actor });
    } catch (error) {
      throw new HandlerError("refused", `feedback_send: GitHub did not take the report: ${error instanceof Error ? error.message : String(error)}. The draft is kept at ${draft.id}.`);
    }
    if (result.route === "issue") return { route: "issue", url: result.url, next: "Give the Human the issue's link." };
    return {
      route: "form",
      url: result.url,
      opened: result.opened,
      next:
        (result.opened ? "The filled-in form is open in the Human's browser: they press submit there. " : "No browser could be opened: give the Human this link to open; they press submit there. ") +
        (result.shortened ? `The report was too long for a link: ask the Human to attach the file ${result.file} to the form. ` : "") +
        "tmb cannot know whether they submitted it.",
    };
  }
}

// The operations as the operation table and the command line call them.
export const feedbackDraft = (store: Store, actor: Actor, input: unknown, context: OperationContext): Promise<FeedbackDraftResult> => new FeedbackService(store, actor, context).draft(input);
export const feedbackSend = (store: Store, actor: Actor, input: unknown, context: OperationContext): FeedbackSendResult => new FeedbackService(store, actor, context).send(input);
