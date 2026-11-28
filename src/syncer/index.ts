// The syncer: what changed on each repo's remote since the last read, folded into the record as
// events by tmb's syncer (trustmybot/tmb#70). A poll only reads the remote. The one write is a
// change to a mirrored issue that the engine asks for before it records the change.
import { githubRepoOf } from "../engine/index.ts";
import { readItem, readRemote } from "./reader.ts";
import type { ItemKind } from "./github.ts";
import { askThroughGh } from "./transport.ts";
import type { ItemAnswer, Kept, ReadAnswer } from "./types.ts";

export { LISTS, NOTHING_KEPT } from "./types.ts";
export type { Cannot, Changes, ItemAnswer, Kept, ListKept, ListName, ReadAnswer, RemoteComment, RemoteIssue, RemoteItem, RemoteMilestone, RemotePullRequest } from "./types.ts";
export { FLOOR_MS, readItem, readRemote } from "./reader.ts";
export type { ReadOptions } from "./reader.ts";
export { askThroughGh, sendThroughGh } from "./transport.ts";
export { remoteIssueWriter, writeIssue } from "./writer.ts";
export { Folder, type FoldCount, syncerActor, UNTITLED } from "./fold.ts";
export { FULL_PASS_MS, GONE_CHECKS_MAX, keptOf, type SyncOptions, type SyncOutcome, syncProject, syncTrigger } from "./sync.ts";
export type { Answer, Ask, Change, Request, Send } from "./transport.ts";
export type { ItemKind, Repo } from "./github.ts";

/** Reads the remote that the project's origin names, through the user's own `gh`. */
export function readProjectRemote(projectDir: string, kept: Kept, options: { now?: Date; force?: boolean; pageLimit?: number } = {}): Promise<ReadAnswer> {
  return readRemote({ repo: githubRepoOf(projectDir), kept, ask: askThroughGh(projectDir), ...options });
}

/** Asks the project's remote for one item directly, to learn whether it is gone. */
export async function readProjectItem(projectDir: string, kind: ItemKind, number: number, now?: Date): Promise<ItemAnswer> {
  const repo = githubRepoOf(projectDir);
  if (repo === null) return { ok: false, cannot: "not_github", why: "origin names no GitHub repository", waitUntil: null };
  return readItem({ repo, ask: askThroughGh(projectDir), kind, number, now });
}
