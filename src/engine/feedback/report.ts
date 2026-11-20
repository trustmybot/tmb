// What a report holds, cleaned, and how it is written: as an issue body in the bug form's
// headings for the GitHub CLI, and as the form's fields for a filled-in form link.
//   In: tmb's version, channel and program name; the OS and its architecture; the host and its
//   version; the command or tool that failed; the error and tmb's own stack; the kinds of the
//   last few events in the record, not their content; a sentence on what was being done.
//   Never: source code, file contents, prompts, an agent's messages, environment variables.
import type { BugForm, FeedbackRepo, KnownField } from "./form.ts";

/** What the person or the planner says about the failure. */
export type ReportInput = {
  /** One sentence: what went wrong. */
  summary: string;
  /** What was being done, in the Human's or the planner's words. */
  whatHappened: string;
  /** The command or tool that failed. */
  command?: string | null;
  /** The error, with tmb's own stack when there is one. */
  error?: string | null;
};

/** What tmb knows about where it ran. */
export type ReportFacts = {
  /** What `tmb --version` prints: the program's name, version and channel. */
  versionLine: string;
  /** The OS, its release and its architecture. */
  os: string;
  /** Each host with its version, as `<host> 2.1.0`. */
  hosts: string[];
  /** The kinds of the last few events in the record, oldest first, as `task updated`. */
  eventKinds: string[];
};

/** Paths to clean: the project's folder becomes `<project>`, the home folder `~`. */
export type CleanPaths = { home: string | null; project: string | null };

export const REMOVED = "<removed>";

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** Escapes text for a regular expression. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces `folder` and anything below it with `name`, with either slash. */
function replaceFolder(text: string, folder: string, name: string): string {
  const trimmed = folder.replace(/[\\/]+$/, "");
  if (trimmed.length < 2) return text;
  const variants = new Set([trimmed, trimmed.replace(/\\/g, "/"), trimmed.replace(/\//g, "\\")]);
  let out = text;
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`${literal(variant)}(?=$|[\\\\/\\s"'\`:;,)\\]}>])`, "g"), name);
  }
  return out;
}

/**
 * Best-effort cleaning before the Human sees a report: the project's folder becomes `<project>`
 * and the home folder `~`, and values that look like tokens or passwords are removed. The Human
 * reads every report because this cannot be complete.
 */
export function cleanText(text: string, paths: CleanPaths): string {
  let out = text;
  if (paths.project) out = replaceFolder(out, paths.project, "<project>");
  if (paths.home) out = replaceFolder(out, paths.home, "~");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REMOVED);
  // Credentials in a URL: scheme://user:password@host.
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REMOVED}@`);
  // An authorization header's value.
  out = out.replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/g, `$1 ${REMOVED}`);
  // name=value and name: value where the name says it is a secret.
  out = out.replace(
    /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    `$1$2${REMOVED}`,
  );
  return out;
}

/** The values of the fields tmb knows, cleaned; the form decides which of them are used. */
export function reportValues(input: ReportInput, facts: ReportFacts, paths: CleanPaths): Record<KnownField, string> {
  const errorParts: string[] = [];
  if (input.command) errorParts.push(`Command or tool: ${input.command.trim()}`);
  if (input.error && input.error.trim() !== "") errorParts.push(input.error.trim());
  const environment = [
    `OS: ${facts.os}`,
    `Host: ${facts.hosts.length === 0 ? "none found" : facts.hosts.join(", ")}`,
    `Recent record events (kinds only, oldest first): ${facts.eventKinds.length === 0 ? "none" : facts.eventKinds.join(", ")}`,
  ];
  const values: Record<KnownField, string> = {
    summary: oneLine(input.summary),
    "what-happened": input.whatHappened.trim(),
    version: facts.versionLine,
    error: errorParts.join("\n\n"),
    environment: environment.join("\n"),
  };
  for (const key of Object.keys(values) as KnownField[]) values[key] = cleanText(values[key], paths);
  return values;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The issue's title: the form's title prefix, if it has one, then the summary. */
export function reportTitle(form: BugForm, values: Record<KnownField, string>): string {
  return `${form.title ?? ""}${values.summary}`.trim();
}

/** The hidden line that names the form a report was drafted from; the labelling workflow reads it. */
export function formMarker(form: BugForm): string {
  return `<!-- tmb-feedback form=${form.file} -->`;
}

/** A fence longer than any run of backticks in `text`. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
}

/**
 * The issue body for the GitHub CLI route: each field of the form under its label, as GitHub
 * writes a submitted form, with `_No response_` for one tmb does not know; then the hidden line.
 * The required checkboxes are ticked: the Human's yes to the whole report is that check.
 */
export function issueBody(form: BugForm, values: Partial<Record<KnownField, string>>): string {
  const known = values as Record<string, string>;
  const sections = form.fields.map((field) => {
    if (field.type === "checkboxes") {
      return `### ${field.label}\n\n${field.boxes.map((box) => `- [${box.required ? "x" : " "}] ${box.label}`).join("\n")}`;
    }
    const value = Object.hasOwn(known, field.id) ? known[field.id]!.trim() : "";
    if (value === "") return `### ${field.label}\n\n_No response_`;
    if (field.render !== null) {
      const fence = fenceFor(value);
      return `### ${field.label}\n\n${fence}${field.render}\n${value}\n${fence}`;
    }
    return `### ${field.label}\n\n${value}`;
  });
  return `${sections.join("\n\n")}\n\n${formMarker(form)}\n`;
}

/** GitHub's new-issue links stop working somewhere past this many characters; VS Code keeps under it. */
export const FORM_LINK_MAX = 7_500;

/** The fields a link fills: those with a value. */
function linkFields(values: Partial<Record<KnownField, string>>): [string, string][] {
  return Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "");
}

function newIssueLink(repo: FeedbackRepo, formFile: string, title: string, values: Partial<Record<KnownField, string>>): string {
  const query = new URLSearchParams([["template", formFile], ["title", title], ...linkFields(values)]);
  return `https://github.com/${repo.owner}/${repo.name}/issues/new?${query.toString()}`;
}

/**
 * The link to the filled-in form. A report too long for a link keeps the first part of the
 * error, and of what happened if it must, and asks in what happened for the whole report,
 * saved at `wholeReport`, to be attached.
 */
export function formLink(
  repo: FeedbackRepo,
  formFile: string,
  title: string,
  values: Partial<Record<KnownField, string>>,
  wholeReport: string,
): { url: string; shortened: boolean } {
  const link = (candidate: Partial<Record<KnownField, string>>) => newIssueLink(repo, formFile, title, candidate);
  const full = link(values);
  if (full.length <= FORM_LINK_MAX) return { url: full, shortened: false };
  const note = `\n\nThe whole report was too long for a link. Please attach the file ${wholeReport} here.`;
  const happened = values["what-happened"] ?? "";
  const shortened: Partial<Record<KnownField, string>> = { ...values, "what-happened": `${happened}${note}`.trim() };
  // Cut the error first, then what happened ahead of its note, each to the longest that fits.
  for (const key of ["error", "what-happened"] as const) {
    const keep = key === "what-happened" ? happened : (shortened.error ?? "");
    const tail = key === "what-happened" ? note : "";
    const cut = (length: number) => (length >= keep.length ? `${keep}${tail}` : `${keep.slice(0, length)}…${tail}`).trim();
    const fits = (length: number) => link({ ...shortened, [key]: cut(length) }).length <= FORM_LINK_MAX;
    if (fits(keep.length)) break;
    let low = 0;
    let high = keep.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle - 1;
    }
    shortened[key] = cut(low);
    if (link(shortened).length <= FORM_LINK_MAX) break;
  }
  return { url: link(shortened), shortened: true };
}
