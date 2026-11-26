import { useMemo, useState, type ReactNode } from 'react';
import type { ElementDefinition, LayoutOptions } from 'cytoscape';
import { FileCodeIcon, FileDirectoryIcon, SearchIcon } from '@primer/octicons-react';
import { query, useApi } from '../api.ts';
import { FIELD } from '../shared/classes.ts';
import { Loading } from '../shared/Loading.tsx';
import { hrefWith, useHashParam } from '../shared/route.ts';
import { AREA_TINTS, GraphCanvas, labelSize } from './code/GraphCanvas.tsx';
import { Subhead } from './RunsView.tsx';

type Base = { commit: string; baseBranch: string };

export type TreeChild =
  | { kind: 'dir'; path: string; name: string; files: number; functions: number; area: string | null }
  | { kind: 'file'; path: string; name: string; lang: string | null; lane: string; functions: number; notParsed: string | null; area: string | null };
export type TreeArea = { name: string; purpose: string; parent: string | null; status: string };
export type TreeData = Base & {
  path: string;
  functions: number;
  children: TreeChild[];
  links: { from: string; to: string; calls: number; imports: number }[];
  areas: TreeArea[];
};

export type FileSymbol = {
  id: number;
  kind: string;
  name: string;
  qualifiedName: string;
  unnamed: boolean;
  parent: number | null;
  startLine: number | null;
  endLine: number | null;
  signature: string;
  unresolved: number;
  callsOut: number;
  calls: CallCounts;
};
/** The calls written in a function by state: linked to the repo's code, outside the repo, not known. */
export type CallCounts = { linked: number; outside: number; notKnown: number };
export type FileData = Base & {
  path: string;
  lang: string | null;
  lane: string;
  notParsed: string | null;
  areas: string[];
  functions: number;
  symbols: FileSymbol[];
  links: { from: number; to: number; count: number }[];
};

/** One caller or callee, listed once with its lines: the first few, and a count of the rest. */
export type NodeRef = { id: number | null; qualifiedName: string; kind: string; path: string; lines: number[]; moreLines: number };
export type FunctionData = Base & {
  id: number;
  name: string;
  unnamed: boolean;
  parent: number | null;
  card: {
    symbol: { kind: string; qualifiedName: string; path: string; startLine: number | null; endLine: number | null; signature: string; doc: string };
    calls: CallCounts;
    callsNote?: string;
  };
  callers: NodeRef[];
  callees: NodeRef[];
  /** How many distinct callers and callees were left out past the cap. */
  more: { callers: number; callees: number };
  unresolved: number;
};

type Hit = { id: number; name: string; qualifiedName: string; kind: string; path: string; line: number | null; unnamed: boolean };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const lines = (start: number | null, end: number | null) => (start === null ? '' : end === null || end === start ? `line ${start}` : `lines ${start}–${end}`);
const callsText = (c: CallCounts) => `${plural(c.linked + c.outside + c.notKnown, 'call')} written: ${c.linked} linked, ${c.outside} outside the repo, ${c.notKnown} not known`;
const hasCalls = (c: CallCounts) => c.linked + c.outside + c.notKnown > 0;
const width = (n: number) => Math.min(1 + Math.log2(n + 1), 6);

const COSE: LayoutOptions = { name: 'cose', animate: false, nodeDimensionsIncludeLabels: true, padding: 24, componentSpacing: 60, nodeRepulsion: () => 8000, idealEdgeLength: () => 80 } as LayoutOptions;
const PRESET: LayoutOptions = { name: 'preset', padding: 24 } as LayoutOptions;

/**
 * The query of a graph read: its own params, and the repo the address names. In a workspace the
 * page names one; in a project of one repo there is none to name.
 */
const graphQuery = (params: Record<string, string>, repo: string | null) => query(repo === null ? params : { ...params, repo });

/** The link to a place on the page: a folder, a file or one function, in the repo the address names. */
export const placeHref = (place: { dir?: string; file?: string; fn?: number }) =>
  hrefWith({ dir: place.dir ?? null, file: place.file ?? null, fn: place.fn === undefined ? null : String(place.fn) }, 'code');

function open(place: { dir?: string; file?: string; fn?: number }) {
  window.location.hash = placeHref(place);
}

const LINK = 'text-fg-link hover:underline';

function Breadcrumb({ path, last }: { path: string; last?: ReactNode }) {
  const parts = path === '.' ? [] : path.split('/');
  const repo = useHashParam('repo');
  return (
    <nav aria-label="Path" className="flex flex-wrap items-center gap-1 text-sm">
      {repo !== null && (
        <span className="flex items-center gap-1">
          <a className={LINK} href={hrefWith({ repo: null, dir: null, file: null, fn: null }, 'code')}>
            (repos)
          </a>
          <span className="text-fg-muted">/</span>
        </span>
      )}
      <a className={LINK} href={placeHref({ dir: '.' })}>
        {repo ?? '(project)'}
      </a>
      {parts.map((part, i) => {
        const at = parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1 && last === undefined;
        return (
          <span key={at} className="flex items-center gap-1">
            <span className="text-fg-muted">/</span>
            {isLast ? <span className="font-semibold">{part}</span> : <a className={LINK} href={i === parts.length - 1 && last !== undefined ? placeHref({ file: at }) : placeHref({ dir: at })}>{part}</a>}
          </span>
        );
      })}
      {last !== undefined && (
        <span className="flex items-center gap-1">
          <span className="text-fg-muted">›</span>
          <span className="font-semibold">{last}</span>
        </span>
      )}
    </nav>
  );
}

function Search({ repo }: { repo: string | null }) {
  const [text, setText] = useState('');
  const hits = useApi<{ hits: Hit[] }>(`graph/search?${graphQuery({ q: text }, repo)}`, { enabled: text.trim().length > 1, keepPrevious: true });
  return (
    <div className="relative w-full max-w-md">
      <label className="flex items-center gap-2">
        <SearchIcon size={16} className="text-fg-muted" aria-hidden="true" />
        <input className={FIELD} type="search" placeholder="Find a function by name" aria-label="Find a function by name" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {text.trim().length > 1 && hits.data && (
        <ul aria-label="Functions found" className="absolute z-10 mt-1 max-h-80 w-full overflow-auto rounded-md border border-border-default bg-canvas text-sm shadow-lg">
          {hits.data.hits.length === 0 && <li className="px-3 py-2 text-fg-muted">No function by that name.</li>}
          {hits.data.hits.map((h) => (
            <li key={h.id}>
              <a className="block px-3 py-1.5 hover:bg-(--bgColor-muted)" href={placeHref({ fn: h.id })} onClick={() => setText('')}>
                <span className={h.unnamed ? 'italic' : 'font-semibold'}>{h.name}</span>
                <span className="block truncate text-xs text-fg-muted">
                  {h.path}
                  {h.line === null ? '' : `:${h.line}`}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An area's box on the canvas; its id cannot be a path, which never starts with a colon. */
const areaNode = (name: string) => `:area:${name}`;

function FolderLevel({ data }: { data: TreeData }) {
  const elements = useMemo<ElementDefinition[]>(
    () => [
      // Each area is a tinted box around the children whose main area it is.
      ...data.areas.map((a, i) => ({ data: { id: areaNode(a.name), kind: 'area', tint: i % AREA_TINTS, label: a.status === 'ok' ? a.name : `${a.name} (${a.status})` } })),
      ...data.children.map((c) => ({
        data: {
          id: c.path,
          kind: c.kind,
          ...(c.area === null ? {} : { parent: areaNode(c.area) }),
          label: c.kind === 'dir' ? `${c.name}/\n${plural(c.functions, 'function')}` : `${c.name}\n${c.notParsed ? 'not parsed' : plural(c.functions, 'function')}`,
          notParsed: c.kind === 'file' && c.notParsed !== null,
        },
      })),
      ...data.links.map((l) => ({ data: { id: `${l.from}→${l.to}`, source: l.from, target: l.to, kind: l.calls > 0 ? 'calls' : 'imports', width: width(l.calls + l.imports) } })),
    ],
    [data],
  );
  const kinds = new Map(data.children.map((c) => [c.path, c.kind]));
  return (
    <>
      <Breadcrumb path={data.path} />
      <p className="text-sm text-fg-muted">
        {plural(data.functions, 'function')} under this folder. Arrows are proven calls (solid) and imports (dashed) between its parts. Click a folder or a file to open it.
      </p>
      {data.areas.length > 0 && (
        <p className="text-sm text-fg-muted" aria-label="Areas">
          Boxes are the project's areas: {data.areas.map((a) => `${a.name} (${a.purpose})`).join('; ')}.
        </p>
      )}
      <GraphCanvas
        label={`The parts of ${data.path}`}
        elements={elements}
        layout={COSE}
        onTap={(id) => {
          const kind = kinds.get(id);
          if (kind !== undefined) open(kind === 'dir' ? { dir: id } : { file: id });
        }}
      />
      <ul aria-label="Folder contents" className="divide-y divide-(--borderColor-muted) rounded-md border border-border-default text-sm">
        {data.children.map((c) => (
          <li key={c.path} className="flex items-center gap-2 px-3 py-1.5">
            {c.kind === 'dir' ? <FileDirectoryIcon size={16} className="text-fg-muted" aria-hidden="true" /> : <FileCodeIcon size={16} className="text-fg-muted" aria-hidden="true" />}
            <a className={LINK} href={c.kind === 'dir' ? placeHref({ dir: c.path }) : placeHref({ file: c.path })}>
              {c.name}
              {c.kind === 'dir' ? '/' : ''}
            </a>
            {c.area !== null && (
              <span className="rounded-full border border-border-default px-1.5 text-xs text-fg-muted" data-area={c.area}>
                {c.area}
              </span>
            )}
            <span className="ml-auto text-fg-muted" data-functions={c.functions}>
              {c.kind === 'file' && c.notParsed ? <span className="text-fg-danger">not parsed: {c.notParsed}</span> : plural(c.functions, 'function')}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function SymbolDetails({ symbol, path }: { symbol: FileSymbol; path: string }) {
  return (
    <div className="space-y-1 rounded-md border border-border-default p-3 text-sm" aria-label="Selected function">
      <p className={symbol.unnamed ? 'italic' : 'font-semibold'}>{symbol.qualifiedName}</p>
      <p className="text-fg-muted">
        {symbol.kind} in {path}, {lines(symbol.startLine, symbol.endLine)}
        {symbol.unresolved > 0 ? ` · ${plural(symbol.unresolved, 'call')} not resolved` : ''}
      </p>
      {hasCalls(symbol.calls) && <p className="text-fg-muted" data-calls>{callsText(symbol.calls)}</p>}
      {symbol.signature && <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-(--bgColor-muted) p-2 font-mono text-xs">{symbol.signature}</pre>}
      <a className={LINK} href={placeHref({ fn: symbol.id })}>
        Callers and callees →
      </a>
    </div>
  );
}

function SymbolTree({ symbols, parent, select }: { symbols: FileSymbol[]; parent: number | null; select: (id: number) => void }) {
  const here = symbols.filter((s) => s.parent === parent);
  if (here.length === 0) return null;
  return (
    <ul className={parent === null ? 'space-y-0.5' : 'ml-5 space-y-0.5 border-l border-(--borderColor-muted) pl-2'}>
      {here.map((s) => (
        <li key={s.id} data-symbol={s.id} data-kind={s.kind}>
          <button type="button" className={`text-left hover:underline ${s.unnamed ? 'italic text-fg-muted' : 'text-fg'}`} onClick={() => select(s.id)}>
            {s.name}
          </button>
          <span className="ml-2 text-xs text-fg-muted">
            {s.kind}, {lines(s.startLine, s.endLine)}
            {s.unresolved > 0 ? `, ${s.unresolved} unresolved` : ''}
          </span>
          <SymbolTree symbols={symbols} parent={s.id} select={select} />
        </li>
      ))}
    </ul>
  );
}

const GAP = 16;
const HEADER = 22;

/**
 * Places a file's symbols: each container's children packed in rows inside it, so a function's
 * nested functions sit within it. Only the innermost nodes get positions; the library draws
 * each container around its children.
 */
export function packSymbols(symbols: FileSymbol[], label: (s: FileSymbol) => string): Map<number, { x: number; y: number }> {
  const kids = new Map<number | null, FileSymbol[]>();
  for (const s of symbols) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
  type Box = { w: number; h: number };
  const size = new Map<number, Box>();
  const offsets = new Map<number | null, { x: number; y: number }[]>();
  /** Rows no wider than a square of the same area would be, or the widest item. */
  const rows = (key: number | null, items: Box[]): Box => {
    const area = items.reduce((sum, b) => sum + (b.w + GAP) * (b.h + GAP), 0);
    const limit = Math.max(Math.sqrt(area) * 1.4, ...items.map((b) => b.w));
    const at: { x: number; y: number }[] = [];
    let x = 0;
    let y = 0;
    let rowH = 0;
    let w = 0;
    for (const b of items) {
      if (x > 0 && x + b.w > limit) {
        y += rowH + GAP;
        x = 0;
        rowH = 0;
      }
      at.push({ x, y });
      x += b.w + GAP;
      rowH = Math.max(rowH, b.h);
      w = Math.max(w, x - GAP);
    }
    offsets.set(key, at);
    return { w, h: y + rowH };
  };
  const measure = (s: FileSymbol): Box => {
    const inside = kids.get(s.id) ?? [];
    const own = labelSize(label(s));
    let out = own;
    if (inside.length > 0) {
      const box = rows(s.id, inside.map(measure));
      out = { w: Math.max(box.w, own.w) + 2 * GAP, h: box.h + HEADER + 2 * GAP };
    }
    size.set(s.id, out);
    return out;
  };
  const at = new Map<number, { x: number; y: number }>();
  const place = (key: number | null, left: number, top: number) => {
    (kids.get(key) ?? []).forEach((s, i) => {
      const o = offsets.get(key)![i]!;
      const box = size.get(s.id)!;
      if ((kids.get(s.id) ?? []).length === 0) at.set(s.id, { x: left + o.x + box.w / 2, y: top + o.y + box.h / 2 });
      else place(s.id, left + o.x + GAP, top + o.y + HEADER + GAP);
    });
  };
  rows(null, (kids.get(null) ?? []).map(measure));
  place(null, 0, 0);
  return at;
}

const fileLabel = (s: FileSymbol) => `${s.name}${s.unresolved > 0 ? `\n${s.unresolved} unresolved` : ''}`;

function FileLevel({ data }: { data: FileData }) {
  const [selected, setSelected] = useState<number | null>(null);
  const elements = useMemo<ElementDefinition[]>(() => {
    const at = packSymbols(data.symbols, fileLabel);
    return [
      ...data.symbols.map((s) => ({
        data: {
          id: String(s.id),
          kind: s.kind,
          unnamed: s.unnamed,
          label: fileLabel(s),
          ...(s.parent === null ? {} : { parent: String(s.parent) }),
        },
        ...(at.has(s.id) ? { position: at.get(s.id)! } : {}),
      })),
      ...data.links.map((l) => ({ data: { id: `${l.from}→${l.to}`, source: String(l.from), target: String(l.to), kind: 'calls', width: width(l.count) } })),
    ];
  }, [data]);
  const chosen = data.symbols.find((s) => s.id === selected) ?? null;
  return (
    <>
      <Breadcrumb path={data.path} last={undefined} />
      <p className="text-sm text-fg-muted">
        {plural(data.functions, 'function')} in this file{data.lang ? ` (${data.lang})` : ''}
        {data.areas.length > 0 ? `, in the area${data.areas.length > 1 ? 's' : ''} ${data.areas.join(', ')}` : ''}. A function drawn inside another is defined inside it; a dashed one has no name of its own. Arrows are proven calls within the file.
      </p>
      {data.notParsed !== null && <p className="text-sm text-fg-danger">This file was not parsed: {data.notParsed}.</p>}
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <GraphCanvas label={`The functions of ${data.path}`} elements={elements} layout={PRESET} onTap={(id) => setSelected(Number(id))} />
        <div className="space-y-3">
          {chosen ? <SymbolDetails symbol={chosen} path={data.path} /> : <p className="text-sm text-fg-muted">Click a function to see its lines and signature.</p>}
        </div>
      </div>
      <section aria-label="Functions in this file" className="rounded-md border border-border-default p-3 text-sm">
        <SymbolTree symbols={data.symbols} parent={null} select={setSelected} />
      </section>
    </>
  );
}

/** A row's lines, `12, 15, 20 (+30 more)`, or '' when none is known. */
function linesText(ref: NodeRef) {
  return ref.lines.length === 0 ? '' : `${ref.lines.join(', ')}${ref.moreLines > 0 ? ` (+${ref.moreLines} more)` : ''}`;
}

/** A node's label: a caller's lines are in its own file; a callee's are where it is called. */
function refLabel(ref: NodeRef, side: string) {
  const name = ref.kind === 'file' ? ref.path : ref.qualifiedName;
  const file = ref.path.slice(ref.path.lastIndexOf('/') + 1);
  const at = linesText(ref);
  if (side === 'callee') return `${name}\n${file}${at === '' ? '' : `\ncalled at ${ref.lines.length + ref.moreLines > 1 ? 'lines' : 'line'} ${at}`}`;
  return `${name}\n${file}${at === '' ? '' : `:${at}`}`;
}

function FunctionLevel({ data }: { data: FunctionData }) {
  const s = data.card.symbol;
  const callers = useMemo(() => dedupe(data.callers), [data]);
  const callees = useMemo(() => dedupe(data.callees), [data]);
  const elements = useMemo<ElementDefinition[]>(() => {
    const column = (refs: NodeRef[], x: number, side: string) =>
      refs.map((r, i) => ({
        data: { id: `${side}:${i}`, kind: r.kind === 'file' ? 'file' : 'function', label: refLabel(r, side) },
        position: { x, y: (i - (refs.length - 1) / 2) * 56 },
      }));
    return [
      {
        data: { id: 'center', kind: s.kind, center: true, unnamed: data.unnamed, label: `${data.name}${data.unresolved > 0 ? `\n${data.unresolved} unresolved` : ''}` },
        position: { x: 0, y: 0 },
      },
      ...column(callers, -340, 'caller'),
      ...column(callees, 340, 'callee'),
      ...callers.map((_, i) => ({ data: { id: `e:caller:${i}`, source: `caller:${i}`, target: 'center', kind: 'calls', width: 1.5 } })),
      ...callees.map((_, i) => ({ data: { id: `e:callee:${i}`, source: 'center', target: `callee:${i}`, kind: 'calls', width: 1.5 } })),
    ];
  }, [data, callers, callees, s.kind]);
  const goTo = (id: string) => {
    const [side, index] = id.split(':');
    const ref = (side === 'caller' ? callers : side === 'callee' ? callees : [])[Number(index)];
    if (!ref) return;
    if (ref.id !== null) open({ fn: ref.id });
    else open({ file: ref.path });
  };
  return (
    <>
      <Breadcrumb path={s.path} last={data.name} />
      <div className="space-y-1 text-sm">
        <p className="text-fg-muted">
          {s.kind} in{' '}
          <a className={LINK} href={placeHref({ file: s.path })}>
            {s.path}
          </a>
          , {lines(s.startLine, s.endLine)}
          {data.parent !== null && (
            <>
              {' · inside '}
              <a className={LINK} href={placeHref({ fn: data.parent })}>
                its container
              </a>
            </>
          )}
        </p>
        {s.signature && <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-(--bgColor-muted) p-2 font-mono text-xs">{s.signature}</pre>}
        <p className="text-fg-muted">
          Callers on the left, what it calls on the right, each proven. Click one to center on it.
          {data.unresolved > 0 ? ` ${plural(data.unresolved, 'call')} it makes could not be resolved to one definition: counted, not drawn.` : ''}
        </p>
        {hasCalls(data.card.calls) && (
          <p className="text-fg-muted" data-calls>
            {callsText(data.card.calls)}
            {data.card.callsNote ? `. ${data.card.callsNote}` : ''}
          </p>
        )}
      </div>
      <GraphCanvas label={`Callers and callees of ${data.name}`} elements={elements} layout={PRESET} onTap={goTo} />
      <div className="grid gap-4 md:grid-cols-2">
        <RefList title="Callers" side="caller" refs={callers} more={data.more.callers} />
        <RefList title="Calls" side="callee" refs={callees} more={data.more.callees} />
      </div>
    </>
  );
}

/** One node per target: a callee reached by two kinds of edge (a call and a construction, say) is drawn once, its lines merged. */
function dedupe(refs: NodeRef[]): NodeRef[] {
  const seen = new Map<string, NodeRef>();
  for (const r of refs) {
    const key = r.id === null ? `file:${r.path}` : String(r.id);
    const had = seen.get(key);
    if (had === undefined) seen.set(key, r);
    else {
      const lines = [...new Set([...had.lines, ...r.lines])].sort((a, b) => a - b);
      const shown = Math.max(had.lines.length, r.lines.length);
      seen.set(key, { ...had, lines: lines.slice(0, shown), moreLines: had.moreLines + r.moreLines + Math.max(0, lines.length - shown) });
    }
  }
  return [...seen.values()];
}

function RefList({ title, side, refs, more }: { title: string; side: 'caller' | 'callee'; refs: NodeRef[]; more: number }) {
  return (
    <section aria-label={title} className="rounded-md border border-border-default p-3 text-sm">
      <h3 className="mb-2 font-semibold">{title}</h3>
      {refs.length === 0 && <p className="text-fg-muted">None proven.</p>}
      <ul className="space-y-1">
        {refs.map((r) => (
          <li key={r.id === null ? `file:${r.path}` : r.id}>
            <a className={LINK} href={r.id === null ? placeHref({ file: r.path }) : placeHref({ fn: r.id })}>
              {r.kind === 'file' ? r.path : r.qualifiedName}
            </a>
            <span className="ml-2 text-xs text-fg-muted">
              {r.path}
              {linesText(r) === '' ? '' : side === 'caller' ? `:${linesText(r)}` : ` · called at ${linesText(r)}`}
            </span>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="mt-2 text-fg-muted">…and {more} more not listed.</p>}
    </section>
  );
}

export function CodeView() {
  const dir = useHashParam('dir');
  const file = useHashParam('file');
  const fn = useHashParam('fn');
  const repo = useHashParam('repo');
  const repos = useApi<{ repos: string[] }>('graph/repos');
  return (
    <div className="space-y-4">
      <Loading q={repos}>
        {({ repos: names }) =>
          // A workspace of several repos opens on their list; the Human picks one, and the address
          // carries it. A project of one repo, or a workspace with one, opens straight on its graph.
          repo === null && names.length > 1 ? (
            <RepoList names={names} />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Subhead>Code Graph</Subhead>
                <Search key={repo} repo={repo} />
              </div>
              {fn !== null ? <FunctionPage id={fn} repo={repo} /> : file !== null ? <FilePage path={file} repo={repo} /> : <FolderPage path={dir ?? '.'} repo={repo} />}
            </>
          )
        }
      </Loading>
    </div>
  );
}

function RepoList({ names }: { names: string[] }) {
  return (
    <section className="space-y-3">
      <Subhead>Code Graph</Subhead>
      <p className="text-sm text-fg-muted">This workspace has {plural(names.length, 'repo')}, each with a graph of its own. Pick one.</p>
      <ul aria-label="Repos" className="divide-y divide-border-default rounded-md border border-border-default">
        {names.map((name) => (
          <li key={name}>
            <a className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-(--bgColor-muted)" href={hrefWith({ repo: name, dir: null, file: null, fn: null }, 'code')}>
              <FileDirectoryIcon size={16} className="text-fg-muted" aria-hidden="true" />
              <span className="font-semibold text-fg-link">{name}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Footer({ data }: { data: Base }) {
  return (
    <p className="text-xs text-fg-muted">
      From the graph of {data.baseBranch} at {data.commit.slice(0, 7)}.
    </p>
  );
}

function FolderPage({ path, repo }: { path: string; repo: string | null }) {
  const q = useApi<TreeData>(`graph/tree?${graphQuery({ path }, repo)}`);
  return <Loading q={q}>{(data) => <><FolderLevel data={data} /><Footer data={data} /></>}</Loading>;
}

function FilePage({ path, repo }: { path: string; repo: string | null }) {
  const q = useApi<FileData>(`graph/file?${graphQuery({ path }, repo)}`);
  return <Loading q={q}>{(data) => <><FileLevel key={data.path} data={data} /><Footer data={data} /></>}</Loading>;
}

function FunctionPage({ id, repo }: { id: string; repo: string | null }) {
  const q = useApi<FunctionData>(`graph/function/${encodeURIComponent(id)}?${graphQuery({}, repo)}`);
  return <Loading q={q}>{(data) => <><FunctionLevel data={data} /><Footer data={data} /></>}</Loading>;
}
