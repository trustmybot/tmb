// The two ways to make the code graph's links (CODE_GRAPH.md, "Two ways to make links"): the
// built-in rules, and the language's own tool. The setting `graph_links` picks one per repo, and
// every link records the way that made it. This file names the ways and nothing else, so the
// settings and the graph share them without loading the graph's parsers.

export const LINK_WAYS = ["built-in", "language-tool"] as const;
export type LinkWay = (typeof LINK_WAYS)[number];

/** The way a repo's graph is built when its setting names none. */
export const DEFAULT_LINK_WAY: LinkWay = "built-in";
/** Way A: the syntax tree and tmb's own lookup rules. */
export const BUILT_IN: LinkWay = "built-in";
/** Way B: the language's compiler or indexer. */
export const LANGUAGE_TOOL: LinkWay = "language-tool";
