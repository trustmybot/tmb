// A repair of one misreading of tree-sitter-typescript 0.23 (trustmybot/tmb#247). A member of
// an interface or object type that starts with `<` on its own line, a generic call signature,
// is read as the type arguments of the type that ends the line before:
//
//   interface Handlers {
//     a: T
//     <U>(b: U): U      // read as `T<U>`, then nothing parses to the end of the file
//   }
//
// The TypeScript compiler never reads a `<` after a line break as type arguments, so this is
// a new member. One error there loses every function after it: hono's
// `src/helper/factory/index.ts` lost its `Factory` class and the functions under it.
//
// The repair writes a `;` over the space before each such `<`: the same length, so every
// line and column stays where it was. It is kept only when the file then parses with fewer
// errors than before.
import type { Node, Parser, Tree } from 'web-tree-sitter';

/** The number of error and missing nodes of a tree. */
export function parseErrors(root: Node): number {
  if (!root.hasError) return 0;
  let n = root.isError || root.isMissing ? 1 : 0;
  for (const child of root.children) if (child) n += parseErrors(child);
  return n;
}

function insideError(node: Node | null): boolean {
  for (let at = node; at; at = at.parent) if (at.isError) return true;
  return false;
}

/** Whether the `<` at this point is read as type arguments or lies in an error. */
function misread(root: Node, row: number, column: number): boolean {
  const node = root.descendantForPosition({ row, column });
  if (!node) return false;
  if (node.type === '<' && node.parent?.type === 'type_arguments' && node.parent.parent?.type === 'generic_type') return true;
  return insideError(node);
}

/**
 * The text with a `;` written over the space before each `<` that starts an indented line and
 * is misread; null when there is none.
 */
export function repairedText(src: string, root: Node): string | null {
  const chars = src.split('');
  let changed = false;
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i <= src.length; i++) {
    if (i < src.length && src[i] !== '\n') continue;
    const line = src.slice(lineStart, i);
    const m = /^([ \t]+)<(?![/=<])/.exec(line);
    if (m && misread(root, row, m[1]!.length)) {
      chars[lineStart + m[1]!.length - 1] = ';';
      changed = true;
    }
    row++;
    lineStart = i + 1;
  }
  return changed ? chars.join('') : null;
}

/**
 * The tree of a file, repaired as above when that leaves fewer errors, with the text it was
 * parsed from. The caller deletes the tree.
 */
export function parseRepaired(parser: Parser, src: string): { tree: Tree; src: string } | null {
  const tree = parser.parse(src);
  if (!tree || !tree.rootNode.hasError) return tree ? { tree, src } : null;
  const fixed = repairedText(src, tree.rootNode);
  if (fixed === null) return { tree, src };
  const second = parser.parse(fixed);
  if (second && parseErrors(second.rootNode) < parseErrors(tree.rootNode)) {
    tree.delete();
    return { tree: second, src: fixed };
  }
  second?.delete();
  return { tree, src };
}
