// Every link is placed where the name it links is written (CODE_GRAPH.md, "Two ways to make
// links": "The position is where the name it calls is written"), so the compiler's answer for
// that one name can be matched to it (trustmybot/tmb#357). That holds for a use that is no call
// too: a function passed as a value, a parent class, a JSX element. A name is one token, so its
// place is the same in every parser of the language. Every expectation is written from that rule,
// by hand: the offset where the name is written in the fixture's text.
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { extractFile } from "../../../../src/engine/graph/extract.ts";
import { loadParsers, type Parsers } from "../../../../src/engine/graph/loader.ts";
import type { ExtractedEdge } from "../../../../src/engine/graph/languages/contract.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const SHEET = `import { renderRow } from "./rows";
import { Base } from "./base";

function header(): string {
  return "h";
}

export class Grid extends Base {}

export function table(rows: string[]): string {
  return [header(), ...rows.map(renderRow), \`\${rows.length}\`].join("\\n");
}

export function both(rows: string[]) {
  return [rows.map(renderRow), rows.map(header)];
}
`;

const VIEW = `import { Panel } from "./panel";

export function page() {
  return <Panel title="t" />;
}
`;

// The same rule in Python, which shares the graph's edges: a parent class is placed at its name.
const MODELS = `from .base import Record


class Invoice(Record):
    pass
`;

// A language with no lookup of its own: a command is a call, placed where its name is written.
const SCRIPT = `#!/bin/sh
prune() {
  echo "pruning"
}
prune && prune
`;

let parsers: Parsers;
beforeAll(async () => {
  parsers = await loadParsers();
});

/** Each calls or instantiates edge of the file, as `name@pos`, with whether it is a call. */
function placed(file: string, lang: "typescript" | "tsx" | "python" | "bash", text: string): string[] {
  const { edges } = extractFile(parsers, file, lang, text);
  return edges.filter((e: ExtractedEdge) => e.kind === "calls" || e.kind === "instantiates").map((e) => `${e.dst_name}@${e.pos ?? "none"}${e.call === 1 ? " call" : ""}`);
}

/** Where `name` is written in `text`: at the first `before` + `name`, after `before`. */
const where = (text: string, before: string, name: string): number => text.indexOf(before + name) + before.length;

describe("every link is placed where the name it links is written", () => {
  test("a function passed as a value, in the shape `[f(), ...xs.map(g)]`, is placed at `g`", () => {
    const tableStart = SHEET.indexOf("export function table");
    const inTable = (before: string, name: string) => SHEET.indexOf(before + name, tableStart) + before.length;
    expect(placed("src/sheet.ts", "typescript", SHEET)).toContain(`renderRow@${inTable("rows.map(", "renderRow")}`);
  });

  test("each function passed as a value, a local one too, is placed where it is written", () => {
    const bothStart = SHEET.indexOf("export function both");
    const inBoth = (before: string, name: string) => SHEET.indexOf(before + name, bothStart) + before.length;
    const edges = placed("src/sheet.ts", "typescript", SHEET);
    expect(edges).toContain(`renderRow@${inBoth("rows.map(", "renderRow")}`);
    expect(edges).toContain(`header@${inBoth("rows.map(", "header")}`);
  });

  test("a parent class is placed at its name", () => {
    expect(placed("src/sheet.ts", "typescript", SHEET)).toContain(`Base@${where(SHEET, "extends ", "Base")}`);
  });

  test("a JSX element is placed at its name", () => {
    expect(placed("src/view.tsx", "tsx", VIEW)).toContain(`Panel@${where(VIEW, "<", "Panel")}`);
  });

  test("a Python parent class is placed at its name", () => {
    expect(placed("app/models.py", "python", MODELS)).toEqual([`Record@${where(MODELS, "Invoice(", "Record")}`]);
  });

  test("a shell command is placed at its name, each of two on one line at its own", () => {
    const second = SCRIPT.lastIndexOf("prune");
    expect(placed("tools/clean.sh", "bash", SCRIPT)).toEqual([`prune@${second - "prune && ".length}`, `prune@${second}`]);
  });

  test("no calls or instantiates edge is left without a place", () => {
    const all = [
      ...placed("src/sheet.ts", "typescript", SHEET),
      ...placed("src/view.tsx", "tsx", VIEW),
      ...placed("app/models.py", "python", MODELS),
      ...placed("tools/clean.sh", "bash", SCRIPT),
    ];
    for (const edge of all) expect(edge).not.toContain("@none");
  });
});
