// The bug form a report follows: `.github/ISSUE_TEMPLATE/bug.yml` as it stands on the repo's
// default branch, read when a report is drafted, with the copy built into tmb when it cannot be
// read. tmb fills the fields it knows by their `id`; the labels and the other questions are the
// form's own (docs/contributing/README.md#issues).
import builtInBugForm from "../../../.github/ISSUE_TEMPLATE/bug.yml" with { type: "text" };

export { builtInBugForm };

/** The repo a report goes to. */
export type FeedbackRepo = { owner: string; name: string };
export const FEEDBACK_REPO: FeedbackRepo = { owner: "trustmybot", name: "tmb" };
export const BUG_FORM_FILE = "bug.yml";
export const BUG_FORM_PATH = `.github/ISSUE_TEMPLATE/${BUG_FORM_FILE}`;

/** The fields tmb fills in, by their `id` in the form. */
export const KNOWN_FIELDS = ["summary", "what-happened", "version", "error", "environment"] as const;
export type KnownField = (typeof KNOWN_FIELDS)[number];

export type FormField = {
  id: string;
  type: string;
  label: string;
  required: boolean;
  /** A textarea's `render`, which GitHub shows as a fenced block. */
  render: string | null;
  /** A checkboxes field's boxes. */
  boxes: { label: string; required: boolean }[];
};

export type BugForm = {
  file: string;
  title: string | null;
  labels: string[];
  fields: FormField[];
  /** Where the form came from: the repo's default branch, or the copy built into tmb. */
  source: "default branch" | "built-in copy";
  /** Why the default branch's form could not be used; null when it was. */
  fallbackReason: string | null;
};

type RawItem = { type?: unknown; id?: unknown; attributes?: { label?: unknown; render?: unknown; options?: unknown }; validations?: { required?: unknown } };

/** Parses an issue form; throws when the text is not one. */
export function parseForm(text: string, source: BugForm["source"], fallbackReason: string | null = null): BugForm {
  const raw = Bun.YAML.parse(text) as { title?: unknown; labels?: unknown; body?: unknown } | null;
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.body)) throw new Error("not an issue form: it has no body");
  const labels = Array.isArray(raw.labels)
    ? raw.labels.filter((label): label is string => typeof label === "string")
    : typeof raw.labels === "string"
      ? raw.labels.split(",").map((label) => label.trim()).filter((label) => label !== "")
      : [];
  const fields: FormField[] = [];
  for (const item of raw.body as RawItem[]) {
    if (item === null || typeof item !== "object" || item.type === "markdown" || typeof item.id !== "string") continue;
    const attributes = item.attributes ?? {};
    const options = Array.isArray(attributes.options) ? attributes.options : [];
    fields.push({
      id: item.id,
      type: String(item.type),
      label: typeof attributes.label === "string" ? attributes.label : item.id,
      required: item.validations?.required === true,
      render: typeof attributes.render === "string" ? attributes.render : null,
      boxes:
        item.type === "checkboxes"
          ? options
              .filter((option): option is { label: string; required?: unknown } => option !== null && typeof option === "object" && typeof option.label === "string")
              .map((option) => ({ label: option.label, required: option.required === true }))
          : [],
    });
  }
  return { file: BUG_FORM_FILE, title: typeof raw.title === "string" ? raw.title : null, labels, fields, source, fallbackReason };
}

/** The form's address on the default branch: one small download that needs no login. */
export function bugFormUrl(repo: FeedbackRepo): string {
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/HEAD/${BUG_FORM_PATH}`;
}

const FORM_TIMEOUT_MS = 5_000;

/** Downloads the form's text from the default branch. */
export async function fetchBugForm(repo: FeedbackRepo): Promise<string> {
  const url = bugFormUrl(repo);
  const response = await fetch(url, { headers: { "user-agent": "tmb-feedback" }, signal: AbortSignal.timeout(FORM_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

/** The form on the default branch, or the built-in copy with the reason the other could not be used. */
export async function readBugForm(fetchForm: () => Promise<string>): Promise<BugForm> {
  try {
    return parseForm(await fetchForm(), "default branch");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return parseForm(builtInBugForm, "built-in copy", reason);
  }
}
