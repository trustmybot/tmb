// The languages of a project's indexed code, as its code graphs record them.
import { existsSync } from "node:fs";
import { baseLanguages, graphDbPath, openGraphDb, openProjectStore, workingRepos, workspaceRepos } from "../engine/index.ts";

/** The languages of one graph's indexed base branch; null when the graph is not indexed yet. */
export function indexedLanguages(projectDir: string, repo: string | null): string[] | null {
  if (!existsSync(graphDbPath(projectDir, repo))) return null;
  const db = openGraphDb(projectDir, repo);
  try {
    const languages = baseLanguages(db);
    return languages.length === 0 && db.query("SELECT 1 FROM layers WHERE layer = 'base'").get() === null ? null : languages;
  } finally {
    db.close();
  }
}

/** The graphs of a project whose record is open: one per repo tmb works in, or the one graph of a single repo (null). */
export function projectGraphs(projectDir: string): (string | null)[] | null {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) return null;
  try {
    const repos = workspaceRepos(opened.store);
    return repos === null ? [null] : workingRepos(repos);
  } finally {
    opened.store.close();
  }
}

/** The languages of every graph of the project, each once; null when the project has no record or no graph is indexed yet. */
export function projectLanguages(projectDir: string): string[] | null {
  const graphs = projectGraphs(projectDir);
  if (graphs === null) return null;
  const each = graphs.map((repo) => indexedLanguages(projectDir, repo)).filter((languages): languages is string[] => languages !== null);
  return each.length === 0 ? null : [...new Set(each.flat())].sort();
}
