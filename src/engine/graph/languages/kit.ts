// Helpers every language's rules may use, with no language's rules of their own: hashing,
// clipping, the doc comment above a definition and a definition's signature.
import { createHash } from 'node:crypto';
import type { Node } from 'web-tree-sitter';
import type { SourceFile } from './contract.ts';

export const STOPWORDS = new Set(
  'a an the and or of to in on for with by is are was were be been when where what which who how why does do did it its this that these those from as at into per not no than then there their them our we you i set get'.split(
    ' ',
  ),
);

export const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

export const DOC_MAX = 1000;

export function splitWords(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .trim();
}

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
export function normalizedHash(node: Node): string {
  const base = node.startIndex;
  let text = node.text;
  const comments = node
    .descendantsOfType('comment')
    .filter((c): c is Node => c !== null)
    .sort((a, b) => b.startIndex - a.startIndex);
  for (const c of comments) text = text.slice(0, c.startIndex - base) + text.slice(c.endIndex - base);
  return md5(oneLine(text));
}

// A comment line that is only a rule: after its marker, three or more of
// -=#*_~/ and spaces, e.g. `# -----` or `// ====`.
export function isRuleLine(line: string): boolean {
  const rest = line
    .replace(/^\s*(\/\*\*?|\/\/|#|\*)/, '')
    .replace(/\*\/\s*$/, '')
    .trim();
  return rest.length >= 3 && /^[-=#*_~/ ]+$/.test(rest);
}

// A rule line, or a framed title: three or more of one of - or =, then text,
// then three or more of the same, e.g. `# --- Section ---`.
export function isBannerLine(line: string): boolean {
  if (isRuleLine(line)) return true;
  const rest = line
    .replace(/^\s*(\/\*\*?|\/\/|#|\*)/, '')
    .replace(/\*\/\s*$/, '')
    .trim();
  return /^([-=])\1{2,}\s*\S.*?\s*\1{3,}$/.test(rest);
}

export function afterLastBanner(lines: string[]): string[] {
  let last = -1;
  lines.forEach((l, i) => {
    if (isBannerLine(l)) last = i;
  });
  return lines.slice(last + 1);
}

// The comment block whose last row is the row right above a definition (or
// above its export), with no blank row between, from after its last banner
// line on; '' when nothing follows that banner.
export function docOf(node: Node): string {
  const anchor = node.parent?.type === 'export_statement' ? node.parent : node;
  const blocks: string[] = [];
  let edge = anchor.startPosition.row;
  let prev = anchor.previousNamedSibling;
  while (prev && prev.type === 'comment' && prev.endPosition.row === edge - 1) {
    blocks.unshift(prev.text);
    edge = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  const lines = afterLastBanner(blocks.flatMap((block) => block.split('\n')));
  const raw = lines
    .map((l) =>
      l
        .replace(/\*\//g, ' ')
        .replace(/^\s*(\/\*\*?|\*|\/\/+|#+)/gm, ' '),
    )
    .join(' ');
  return clip(oneLine(raw), DOC_MAX);
}
// A definition's text up to its body, on one line.
export function signatureOf(node: Node, src: string): string {
  const body = node.childForFieldName('body');
  const end = body ? body.startIndex : Math.min(node.endIndex, node.startIndex + 160);
  return clip(oneLine(src.slice(node.startIndex, end)), 200);
}
export function named(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

// A long receiver expression is clipped with a trailing ellipsis so the edge
// stays a member call yet can match no `${type}.${method}` name.
export const memberHint = (receiver: string): string =>
  receiver.length < 40 || /^[\w$]+$/.test(receiver) ? receiver : `${receiver.slice(0, 39)}…`;

/** The syntax tree of a file whose language has a grammar; a parse that gave none is a bug. */
export const syntaxTree = (file: SourceFile): Node => {
  if (!file.root) throw new Error(`no syntax tree for ${file.relPath}`);
  return file.root;
};
