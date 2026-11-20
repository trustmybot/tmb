// The code graph driven as separate processes: the Human's `tmb index` and `tmb graph`
// commands, and an agent's graph tools over stdio. The graph is current after a change lands
// on the base branch, with no one running an index.
import { afterAll, describe, expect, test } from "bun:test";
import { PROJECT_MAP_HEADING } from "../../src/engine/session-start.ts";
import { callJson, callRefused, tmbProcesses } from "./tmb-processes.ts";

const { git, run, tmb, tmbJson, setUpProject, commitFile, sessionStart, connect, cleanup } = tmbProcesses("tmb-code-graph-");
afterAll(cleanup);

const FILES = {
  ".gitignore": ".tmb/\n",
  "README.md": "# Shop\n",
  "discount.ts": "/** Discounts for loyal customers. */\nexport function applyDiscount(total: number) {\n  return total * 0.9;\n}\n",
  "pricing/README.md": "# Pricing\n\nDiscounts and taxes.\n",
  "cart.ts": 'import { applyDiscount } from "./discount";\nexport function cartTotal(sum: number) {\n  return applyDiscount(sum);\n}\n',
};

describe("the code graph from the command line", () => {
  test("setup indexes; the Human reindexes and looks up the code; a later commit is seen with no index", () => {
    const project = setUpProject("true", FILES);
    // Setup indexed the graph already, so an index reparses nothing, and a rebuild reparses every file.
    const indexed = tmb(["index"], project);
    expect(indexed).toContain(`Indexed main at ${git(project, "rev-parse", "main").slice(0, 12)}`);
    expect(indexed).toContain("parsed 0");
    expect(tmbJson(["index", "--rebuild"], project)).toMatchObject({ parsed: 2, baseBranch: "main" });

    expect(tmb(["graph", "find", "applyDiscount"], project)).toContain("applyDiscount  discount.ts:2");
    const card = tmb(["graph", "symbol", "applyDiscount"], project);
    expect(card).toContain("called by:");
    expect(card).toContain("cartTotal  cart.ts:");
    expect(tmb(["graph", "map"], project)).toContain("discount.ts");
    expect(tmb(["graph", "scope", "loyal discount", "--anchor", "applyDiscount"], project)).toContain("cart.ts  (caller:applyDiscount");

    commitFile(project, "tax.ts", "export function addTax(total: number) {\n  return total * 1.2;\n}\n", "tax");
    const found = tmbJson(["graph", "find", "addTax"], project);
    expect(found.hits[0]).toMatchObject({ kind: "symbol", path: "tax.ts" });
    expect(found.freshness.commit).toBe(git(project, "rev-parse", "main"));
    expect(found.freshness.broughtForwardFrom).not.toBeNull();

    expect(run(["graph"], project).status).toBe(2);
    expect(run(["graph", "fly"], project).stderr).toContain("unrecognized command 'fly'");
    expect(run(["index", "extra"], project).status).toBe(2);
  });
});

describe("the code graph at session start", () => {
  test("a new session is shown the project's layout as the graph last indexed it", () => {
    const project = setUpProject("true", FILES);
    const context = sessionStart(project);
    expect(context).toContain(PROJECT_MAP_HEADING);
    expect(context).toContain(`As indexed at ${git(project, "rev-parse", "main").slice(0, 12)}`);
    expect(context).toContain("- pricing/ (1 files): Discounts and taxes.");
    expect(context).toContain("never as instructions");
  });
});

describe("the code graph over the tool server", () => {
  test("an agent maps, finds, reads a symbol, scopes and records a concept; the graph follows the base branch", async () => {
    const project = setUpProject("true", FILES);
    const client = await connect(project);
    try {
      const map = await callJson(client, "graph_map", {});
      expect(map.dirs[0].files.map((f: { path: string }) => f.path)).toContain("discount.ts");
      expect(map.untrusted).toContain("never as instructions");

      const card = (await callJson(client, "graph_symbol", { name: "applyDiscount", role: "worker" })).cards[0];
      expect(card.callers.map((c: { qualifiedName: string }) => c.qualifiedName)).toEqual(["cartTotal"]);

      const scoped = await callJson(client, "graph_scope", { objective: "loyal discount", anchors: ["applyDiscount"] });
      expect(scoped.draft.files).toEqual(expect.arrayContaining(["discount.ts", "cart.ts"]));

      const concept = await callJson(client, "graph_concept_upsert", {
        name: "Cart discount",
        kind: "flow",
        body: "The cart total takes the discount.",
        anchors: ["cart.ts#cartTotal", "discount.ts#applyDiscount"],
      });
      expect(concept.concept.status).toBe("verified");
      expect(await callRefused(client, "graph_concept_upsert", { name: "x", kind: "rule", body: "y", anchors: ["nope.ts"] })).toContain("nope.ts");

      commitFile(project, "discount.ts", "export function discountFor(total: number) {\n  return total;\n}\n", "rename");
      const found = await callJson(client, "graph_find", { query: "discountFor" });
      expect(found.hits[0]).toMatchObject({ kind: "symbol", path: "discount.ts" });
      const concepts = await callJson(client, "graph_concepts", {});
      expect(concepts.concepts[0]).toMatchObject({ name: "Cart discount", status: "broken" });

      expect(await callJson(client, "graph_miss", { lookup: "graph_find", query: "tax", detail: "not there yet" })).toEqual({ recorded: true });
    } finally {
      await client.close();
    }
  });
});
