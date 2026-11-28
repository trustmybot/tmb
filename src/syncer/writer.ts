// A change to a mirrored issue, written to its remote before the record takes it (trustmybot/tmb#70).
// The engine asks for it whoever holds the issue action, the Human on the dashboard or the planner
// through its tool. The answer is what the remote holds afterwards, or why it did not take the
// change, in plain words. Notes and decisions are never sent.
import type { RemoteIssueAnswer, RemoteIssueEdit, RemoteIssueTarget, RemoteIssueWriter } from "../engine/index.ts";
import { numberInUrl } from "./fold.ts";
import { type Repo, toIssue } from "./github.ts";
import { type Answer, type Ask, askThroughGh, nextPage, type Send, sendThroughGh, waitAsked } from "./transport.ts";

type Sent = Extract<Answer, { sent: true }>;

/** The remote repository a mirrored row names, as host/owner/name; null when it names none. */
function repoOf(remote: string): Repo | null {
  const [host, owner, name, ...rest] = remote.split("/");
  return host && owner && name && rest.length === 0 ? { host, owner, name } : null;
}

const messageOf = (body: string): string => {
  try {
    const said = (JSON.parse(body) as { message?: unknown }).message;
    return typeof said === "string" ? said : "";
  } catch {
    return "";
  }
};

/** Why the remote did not take the change, in plain words; null when it did. */
export function refusalOf(answer: Answer, repo: Repo, now: Date): string | null {
  if (!answer.sent) {
    switch (answer.why) {
      case "no_client":
        return "gh, GitHub's command line, is not installed; install it and run `gh auth login`";
      case "no_sign_in":
        return "gh is not signed in to GitHub; run `gh auth login`";
      case "no_network":
        return "GitHub could not be reached; check the network and try again";
      case "failed":
        return `gh failed: ${answer.said}`;
    }
  }
  const { status } = answer;
  if (status >= 200 && status < 300) return null;
  const said = messageOf(answer.body);
  const wait = waitAsked(answer, now);
  if (wait !== null) return `GitHub's rate limit is reached; try again after ${wait}`;
  if (status === 401) return "GitHub refused gh's sign-in; run `gh auth login` again";
  if (status === 403) return `your GitHub account may not change issues in ${repo.owner}/${repo.name}: it has no write access there`;
  if (status === 404) return "GitHub does not show this issue to your account: it was deleted, or your account cannot see it";
  if (status === 410) return "the issue was deleted on GitHub";
  if (status === 301 || status === 307) return "the issue moved on GitHub; the next sync finds where it is now, then try again";
  if (status === 422) return `GitHub refused the change${said === "" ? "" : `: ${said}`}`;
  return `GitHub answered ${status}${said === "" ? "" : `: ${said}`}`;
}

/** The milestone's number on the remote, found by its id in the remote's list of milestones. */
async function milestoneNumber(ask: Ask, repo: Repo, remoteId: string, now: Date): Promise<{ number: number } | { why: string }> {
  let path: string | null = `repos/${repo.owner}/${repo.name}/milestones?state=all&per_page=100`;
  while (path !== null) {
    const answer = await ask({ host: repo.host, path });
    const refused = refusalOf(answer, repo, now);
    if (refused !== null) return { why: refused };
    const page = answer as Sent;
    let list: unknown;
    try {
      list = JSON.parse(page.body);
    } catch {
      return { why: "GitHub's list of milestones could not be read" };
    }
    const found = Array.isArray(list) ? list.find((milestone) => milestone?.node_id === remoteId) : undefined;
    if (found !== undefined) return { number: Number(found.number) };
    path = nextPage(page.headers);
  }
  return { why: "the milestone is gone from GitHub; the next sync brings that in" };
}

/** Writes one change to a mirrored issue on its remote. Never throws. */
export async function writeIssue(options: { ask: Ask; send: Send; target: RemoteIssueTarget; edit: RemoteIssueEdit; now?: Date }): Promise<RemoteIssueAnswer> {
  const { ask, send, target, edit } = options;
  const now = options.now ?? new Date();
  const repo = repoOf(target.remote);
  const number = numberInUrl(target.url);
  if (repo === null || number === null) return { ok: false, why: "the record holds no address for it on the remote" };
  const fields: Record<string, unknown> = {};
  if (edit.title !== undefined) fields.title = edit.title;
  if (edit.body !== undefined) fields.body = edit.body;
  if (edit.state !== undefined) fields.state = edit.state;
  if (edit.milestone === null) fields.milestone = null;
  else if (edit.milestone !== undefined) {
    const found = await milestoneNumber(ask, repo, edit.milestone.remoteId, now);
    if ("why" in found) return { ok: false, why: found.why };
    fields.milestone = found.number;
  }
  let answer: Answer;
  try {
    answer = await send({ host: repo.host, path: `repos/${repo.owner}/${repo.name}/issues/${number}`, method: "PATCH", fields });
  } catch (error) {
    return { ok: false, why: `gh failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const refused = refusalOf(answer, repo, now);
  if (refused !== null) return { ok: false, why: refused };
  try {
    const issue = toIssue(JSON.parse((answer as Sent).body), target.remote);
    return {
      ok: true,
      issue: { title: issue.title, body: issue.body, state: issue.state, stateReason: issue.stateReason, milestoneRemoteId: issue.milestoneRemoteId, remoteUpdatedAt: issue.remoteUpdatedAt },
    };
  } catch {
    return { ok: false, why: "GitHub's answer could not be read; the change may have reached GitHub, and the next sync brings in what it holds" };
  }
}

/** Writes a change to one of the project's mirrored issues through the user's own `gh`. */
export function remoteIssueWriter(projectDir: string): RemoteIssueWriter {
  return (target, edit) => writeIssue({ ask: askThroughGh(projectDir), send: sendThroughGh(projectDir), target, edit });
}
