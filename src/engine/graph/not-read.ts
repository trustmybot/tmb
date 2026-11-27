// What the graph does not read, for lookups that come back empty (trustmybot/tmb#234): code in a
// language tmb has no module for is in the graph as files with no symbols, so an empty answer
// names those languages instead of reading as "there is nothing".
import type { Database } from "bun:sqlite";
import { type NotRead, parseNotRead } from "./build.ts";
import { unreadLanguageOf } from "./languages/unread.ts";

/** A file the graph has but whose language it does not read. */
export type UnreadFile = { path: string; language: string };

/** What an empty lookup adds: the languages the graph does not read, and the file asked for when it is in one. */
export type NotReadNote = { unreadLanguages?: NotRead["languages"]; unreadFile?: UnreadFile };

/** The note for a lookup that found nothing; empty when the graph reads every language it holds. */
export function notReadNote(db: Database, layer: string, asked?: string): NotReadNote {
  const languages = layerNotRead(db, layer).languages;
  const file = asked === undefined ? null : unreadFile(db, layer, asked);
  return { ...(languages.length > 0 ? { unreadLanguages: languages } : {}), ...(file !== null ? { unreadFile: file } : {}) };
}

/** The CLI's lines for the note. */
export function notReadLines(note: NotReadNote): string[] {
  const lines: string[] = [];
  if (note.unreadFile) lines.push(`${note.unreadFile.path} is in the graph, but the code graph does not read ${note.unreadFile.language}, so it has no symbols.`);
  if (note.unreadLanguages && note.unreadLanguages.length > 0 && !note.unreadFile) {
    lines.push(`The code graph does not read ${unreadLanguagesText({ languages: note.unreadLanguages, leftOut: [] })}; what is there is not searched.`);
  }
  return lines;
}

/** The counts the layer's build stored. */
export function layerNotRead(db: Database, layer: string): NotRead {
  const row = db.query("SELECT not_read FROM layers WHERE layer = ?").get(layer) as { not_read: string } | null;
  return parseNotRead(row?.not_read);
}

/** The file at this path when the graph has it and does not read its language, else null. */
export function unreadFile(db: Database, layer: string, path: string): UnreadFile | null {
  const language = unreadLanguageOf(path, new Set(layerNotRead(db, layer).languages.map((l) => l.name)));
  if (language === null) return null;
  const row = db.query("SELECT 1 FROM files WHERE layer = ? AND path = ? AND lang IS NULL").get(layer, path);
  return row === null ? null : { path, language };
}

/** "Go (49 files), Rust (3 files)". */
export function unreadLanguagesText(notRead: NotRead): string {
  return notRead.languages.map((l) => `${l.name} (${l.files} ${l.files === 1 ? "file" : "files"})`).join(", ");
}

/** "not read: Go 49 files; left out: dist/ 12 files; statements not parsed: 3", or "" when the graph reads everything. */
export function notReadSummary(notRead: NotRead): string {
  const count = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
  const parts: string[] = [];
  if (notRead.languages.length > 0) parts.push(`not read: ${notRead.languages.map((l) => `${l.name} ${count(l.files)}`).join(", ")}`);
  if (notRead.leftOut.length > 0) parts.push(`left out: ${notRead.leftOut.map((l) => `${l.rule} ${count(l.files)}`).join(", ")}`);
  if (notRead.statements) parts.push(`statements not parsed: ${notRead.statements}`);
  return parts.join("; ");
}
