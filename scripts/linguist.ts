// Writes src/engine/linguist/languages.json from GitHub Linguist's lib/linguist/languages.yml.
// The engine ships that table so a docs task's close can tell a programming language from prose,
// markup and data by file name. Only the fields the engine reads are kept.
//
//   bun scripts/linguist.ts <path to languages.yml> <linguist commit>
//
// Download the file at a commit of https://github.com/github-linguist/linguist and name that commit,
// so the table says which Linguist it came from.
import { writeFileSync } from "node:fs";
import path from "node:path";

const [source, commit] = process.argv.slice(2);
if (!source || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error("usage: bun scripts/linguist.ts <path to languages.yml> <40-character linguist commit>");
  process.exit(2);
}

type Language = { type: string; extensions?: string[]; filenames?: string[] };
const parsed = Bun.YAML.parse(await Bun.file(source).text()) as Record<string, Language>;

const languages: Record<string, { type: string; extensions?: string[]; filenames?: string[] }> = {};
for (const name of Object.keys(parsed).sort()) {
  const { type, extensions, filenames } = parsed[name]!;
  if (!extensions?.length && !filenames?.length) continue;
  languages[name] = { type, ...(extensions?.length ? { extensions } : {}), ...(filenames?.length ? { filenames } : {}) };
}

const out = path.join(import.meta.dir, "..", "src", "engine", "linguist", "languages.json");
writeFileSync(out, `${JSON.stringify({ source: `github-linguist/linguist@${commit}`, languages }, null, 1)}\n`);
console.log(`wrote ${Object.keys(languages).length} languages to ${out}`);
