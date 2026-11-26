// bash and sh, read through tree-sitter: functions, the commands they run and the files they source.
import bashWasm from 'tree-sitter-bash/tree-sitter-bash.wasm' with { type: 'file' };
import { basename } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { Collector, LanguageModule } from '../contract.ts';
import { docOf, named, normalizedHash, syntaxTree } from '../kit.ts';
import { sqlRefs } from '../sql/index.ts';

const SH_BUILTINS = new Set(
  'echo printf local export declare readonly return exit set unset shift cd test [ [[ true false read eval exec trap wait source . if then else fi for do done while case esac cat grep sed awk tr cut head tail sort uniq wc mkdir rm cp mv ln chmod touch date sleep command type jq git basename dirname xargs find tee env mktemp pwd kill ps sqlite3 node bash sh python3 curl gh'.split(
    ' ',
  ),
);

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function extractBash(root: Node, out: Collector, moduleSymbol: number): void {
  const visit = (node: Node, scope: number): void => {
    let inner = scope;
    const t = node.type;
    if (t === 'function_definition') {
      const n = node.childForFieldName('name')?.text;
      if (n) {
        inner = out.symbol({
          kind: 'sh_function',
          qualified_name: n,
          signature: `${n}()`,
          doc: docOf(node),
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          body_hash: normalizedHash(node),
          exported: 1,
          parent: scope,
        });
      }
    } else if (t === 'command') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode?.text;
      const args = named(node)
        .filter((c) => c.type !== 'command_name')
        .map((c) => stripQuotes(c.text));
      const line = node.startPosition.row + 1;
      if (name === 'source' || name === '.') {
        if (args[0]) out.edge(scope, 'sources', basename(args[0]), line);
      } else if (name && /\.sh$/.test(name)) out.edge(scope, 'runs', basename(name), line);
      else if ((name === 'bash' || name === 'sh') && args[0] && /\.sh$/.test(args[0])) {
        out.edge(scope, 'runs', basename(args[0]), line);
      } else if (name && /^[A-Za-z_][\w-]*$/.test(name) && !SH_BUILTINS.has(name)) {
        // Placed where the command's name is written, as every call is.
        out.edge(scope, 'calls', name, line, null, undefined, undefined, undefined, nameNode!.startIndex);
      }
    } else if (t === 'string' || t === 'raw_string' || t === 'heredoc_body') {
      const line = node.startPosition.row + 1;
      for (const [kind, table] of sqlRefs(node.text)) out.edge(scope, kind, table, line);
    }
    for (const c of named(node)) visit(c, inner);
  };
  visit(root, moduleSymbol);
}

export const bash: LanguageModule = {
  name: 'bash',
  extensions: ['sh', 'bash'],
  shebang: /^#!.*\b(bash|sh)\b/,
  grammar: bashWasm,
  comment: 'hash',
  extract: (file, out) => extractBash(syntaxTree(file), out, file.module),
};
