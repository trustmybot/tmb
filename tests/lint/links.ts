// Checks every relative link in the tracked markdown files: the target file exists, and an
// #anchor into a markdown file matches one of its headings. http(s) and mailto links are skipped.
//   bun tests/lint/links.ts     run from anywhere inside the repo; exits 1 on any broken link
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type BrokenLink = { file: string; line: number; target: string; reason: string };

// [text](target) and ![alt](target); the target may be <bracketed> and carry a "title".
const INLINE_LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
// [label]: target
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;
const SKIPPED_SCHEME = /^(?:https?:|mailto:)/i;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

/** GitHub's heading anchor: lowercase, punctuation dropped except hyphens and underscores, spaces to hyphens. */
export function slugify(heading: string): string {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // a link in a heading keeps only its text
    .replace(/<[^>]+>/g, "");
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "")
    .replace(/ /g, "-");
}

/** The lines outside fenced code blocks, with their 1-based numbers. */
function proseLines(markdown: string): { text: string; line: number }[] {
  const lines: { text: string; line: number }[] = [];
  let fence: string | null = null;
  markdown.split(/\r?\n/).forEach((text, index) => {
    const marker = FENCE.exec(text)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    if (marker) {
      fence = marker;
      return;
    }
    lines.push({ text, line: index + 1 });
  });
  return lines;
}

/** Every anchor a markdown file defines, numbered -1, -2… for repeated headings as GitHub does. */
export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const { text } of proseLines(markdown)) {
    const heading = HEADING.exec(text)?.[1];
    if (heading === undefined) continue;
    const slug = slugify(heading);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

function linkTargets(line: string): string[] {
  const withoutCode = line.replace(/`+[^`]*`+/g, "");
  const targets = [...withoutCode.matchAll(INLINE_LINK)].map((match) => match[1] ?? "");
  const reference = REFERENCE_DEFINITION.exec(withoutCode)?.[1];
  if (reference !== undefined) targets.push(reference);
  return targets.map((target) => target.replace(/^<|>$/g, ""));
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Checks the links in the given repo-relative markdown files under root. */
export function checkLinks(root: string, files: string[]): BrokenLink[] {
  const broken: BrokenLink[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (absolute: string): Set<string> => {
    let anchors = anchorCache.get(absolute);
    if (!anchors) {
      anchors = anchorsOf(readFileSync(absolute, "utf8"));
      anchorCache.set(absolute, anchors);
    }
    return anchors;
  };

  for (const file of files) {
    const absoluteFile = path.join(root, file);
    for (const { text, line } of proseLines(readFileSync(absoluteFile, "utf8"))) {
      for (const target of linkTargets(text)) {
        if (target === "" || SKIPPED_SCHEME.test(target)) continue;
        const hashAt = target.indexOf("#");
        const pathPart = safeDecode(hashAt === -1 ? target : target.slice(0, hashAt));
        const anchor = hashAt === -1 ? null : safeDecode(target.slice(hashAt + 1));
        const report = (reason: string) => broken.push({ file, line, target, reason });

        const resolved = pathPart === "" ? absoluteFile : path.resolve(path.dirname(absoluteFile), pathPart.split("?")[0]!);
        if (!existsSync(resolved)) {
          report("no such file");
          continue;
        }
        if (anchor === null || anchor === "" || !resolved.toLowerCase().endsWith(".md") || statSync(resolved).isDirectory()) continue;
        if (!anchorsFor(resolved).has(anchor.toLowerCase())) report(`no heading for #${anchor}`);
      }
    }
  }
  return broken;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

if (import.meta.main) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const files = git(root, ["ls-files", "-z", "--", "*.md"]).split("\0").filter(Boolean);
  const broken = checkLinks(root, files);
  for (const link of broken) console.log(`${link.file}:${link.line}: ${link.target} (${link.reason})`);
  console.log(broken.length === 0 ? `links: ${files.length} markdown files, no broken links` : `links: ${broken.length} broken`);
  process.exitCode = broken.length === 0 ? 0 : 1;
}
