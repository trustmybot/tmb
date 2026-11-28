import { useEffect, useRef, useState } from 'react';
import cytoscape, { type ElementDefinition, type LayoutOptions } from 'cytoscape';

/** A token's value on the page, for the drawing library, which cannot read CSS variables. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** The tints an area's box takes, in turn; the page's muted colors, so text on them stays readable. */
const AREA_TINT_TOKENS: [string, string][] = [
  ['--bgColor-success-muted', '#dafbe1'],
  ['--bgColor-attention-muted', '#fff8c5'],
  ['--bgColor-severe-muted', '#fff1e5'],
  ['--bgColor-sponsors-muted', '#ffeff7'],
  ['--bgColor-accent-muted', '#ddf4ff'],
  ['--bgColor-done-muted', '#fbefff'],
];
export const AREA_TINTS = AREA_TINT_TOKENS.length;

function graphStyle(): cytoscape.StylesheetJson {
  const fg = token('--fgColor-default', '#1f2328');
  const muted = token('--fgColor-muted', '#59636e');
  const canvas = token('--bgColor-default', '#ffffff');
  const border = token('--borderColor-default', '#d1d9e0');
  const accent = token('--borderColor-accent-emphasis', '#0969da');
  const accentBg = token('--bgColor-accent-muted', '#ddf4ff');
  const doneBg = token('--bgColor-done-muted', '#fbefff');
  const done = token('--borderColor-done-emphasis', '#8250df');
  const danger = token('--borderColor-danger-emphasis', '#cf222e');
  const inset = token('--bgColor-muted', '#f6f8fa');
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-size': 11,
        color: fg,
        'text-wrap': 'wrap',
        'text-max-width': '160px',
        'text-valign': 'center',
        'text-halign': 'center',
        shape: 'round-rectangle',
        width: 'data(w)',
        height: 'data(h)',
        'background-color': canvas,
        'border-width': 1,
        'border-color': border,
      },
    },
    { selector: 'node[kind = "dir"]', style: { 'background-color': inset, 'font-weight': 'bold' } },
    { selector: 'node[kind = "function"], node[kind = "method"]', style: { 'background-color': accentBg, 'border-color': accent } },
    { selector: 'node[?unnamed]', style: { 'border-style': 'dashed', 'font-style': 'italic' } },
    { selector: 'node[kind = "type"]', style: { 'background-color': doneBg, 'border-color': done } },
    { selector: 'node[?notParsed]', style: { 'border-color': danger, 'border-style': 'dashed', 'border-width': 2 } },
    { selector: 'node[?center]', style: { 'border-width': 3, 'font-weight': 'bold' } },
    {
      selector: ':parent',
      style: { 'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -4, padding: '14px', 'background-opacity': 0.35 },
    },
    {
      selector: 'node[kind = "area"]',
      style: { 'background-opacity': 0.6, 'border-style': 'dashed', 'border-color': border, 'font-weight': 'bold', color: muted, events: 'no' },
    },
    ...AREA_TINT_TOKENS.map(([name, fallback], i) => ({ selector: `node[kind = "area"][tint = ${i}]`, style: { 'background-color': token(name, fallback) } })),
    { selector: 'node:selected', style: { 'border-color': accent, 'border-width': 3 } },
    {
      selector: 'edge',
      style: {
        width: 'data(width)',
        'line-color': muted,
        'target-arrow-color': muted,
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        opacity: 0.6,
        'arrow-scale': 0.8,
      },
    },
    { selector: 'edge[kind = "imports"]', style: { 'line-style': 'dashed' } },
  ];
}

/** The size a node needs for its label, which the library no longer works out by itself. */
export function labelSize(label: string): { w: number; h: number } {
  const lines = label.split('\n');
  const longest = Math.min(Math.max(...lines.map((l) => l.length)), 26);
  return { w: longest * 6.6 + 20, h: lines.length * 14 + 14 };
}

function sized(elements: ElementDefinition[]): ElementDefinition[] {
  return elements.map((el) => (el.data.source !== undefined ? el : { ...el, data: { ...el.data, ...labelSize(String(el.data.label ?? '')) } }));
}

/**
 * Draws one level of the code graph. A tap on a node calls `onTap` with its id. When the page
 * cannot draw (no canvas), it shows nothing here and the list beside it stays the way in.
 */
export function GraphCanvas({ elements, layout, onTap, label }: { elements: ElementDefinition[]; layout: LayoutOptions; onTap: (id: string) => void; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const tap = useRef(onTap);
  tap.current = onTap;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!box.current) return;
    let cy: cytoscape.Core | null = null;
    try {
      cy = cytoscape({
        container: box.current,
        elements: sized(elements),
        style: graphStyle(),
        layout,
        minZoom: 0.1,
        maxZoom: 3,
        boxSelectionEnabled: false,
      });
      cy.on('tap', 'node', (event) => tap.current(event.target.id()));
      const core = cy;
      const fit = () => {
        core.resize();
        core.fit(undefined, 24);
        // A few nodes are not blown up to fill the box.
        if (core.zoom() > 1.2) {
          core.zoom(1.2);
          core.center();
        }
      };
      fit();
      const watch = new ResizeObserver(fit);
      watch.observe(box.current);
      core.one('destroy', () => watch.disconnect());
      setFailed(false);
    } catch {
      setFailed(true);
    }
    return () => cy?.destroy();
  }, [elements, layout]);
  if (failed) return null;
  return <div ref={box} role="img" aria-label={label} className="h-[60vh] min-h-[420px] w-full rounded-md border border-border-default bg-canvas" />;
}
