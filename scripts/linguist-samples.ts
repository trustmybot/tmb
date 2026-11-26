// Checks tmb's copy of Linguist's rules against Linguist's own samples (CODE_GRAPH.md, "Checked
// against Linguist's own samples", trustmybot/tmb#154): for every sample of the release tmb carries,
// tmb must name the sample's language or give no answer. Naming another language is a failure.
// The samples are Linguist's test data: fetched here into a folder outside the repo, never carried
// and never run in `ci`.
//
//   bun scripts/linguist-samples.ts <folder for the samples>
//
// It prints how many samples there are, and how many tmb names right, gives no answer for, and
// names wrong; it exits 1 when any is wrong. A sample under `filenames/` is named by its file name.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { linguist, LINGUIST_RELEASE } from "../src/engine/linguist/index.ts";

const [folder] = process.argv.slice(2);
if (!folder) {
  console.error("usage: bun scripts/linguist-samples.ts <folder for the samples>");
  process.exit(2);
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// Linguist's samples at the release tmb carries, and nothing else of the repo.
if (!existsSync(path.join(folder, ".git"))) {
  spawnSync("mkdir", ["-p", folder]);
  git(folder, "init", "-q");
  git(folder, "remote", "add", "origin", `https://github.com/${LINGUIST_RELEASE.repo}.git`);
  git(folder, "sparse-checkout", "set", "--no-cone", "/samples/");
  git(folder, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", `refs/tags/${LINGUIST_RELEASE.tag}`);
  git(folder, "checkout", "-q", "FETCH_HEAD");
}
const at = git(folder, "rev-parse", "HEAD^{commit}");
if (at !== LINGUIST_RELEASE.commit) {
  console.error(`${folder} is at ${at}, not Linguist ${LINGUIST_RELEASE.tag} (${LINGUIST_RELEASE.commit})`);
  process.exit(1);
}

// A language's folder is its fs_name when it has one, else its name.
const list = linguist();
const yaml = Bun.YAML.parse(readFileSync(path.join(import.meta.dir, "../src/engine/linguist/data/languages.yml"), "utf8")) as Record<string, { fs_name?: string }>;
const byFolder = new Map(Object.entries(yaml).map(([name, entry]) => [entry.fs_name ?? name, name]));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

let right = 0;
let none = 0;
const wrong: string[] = [];
const samples = path.join(folder, "samples");
for (const languageFolder of readdirSync(samples).sort()) {
  const language = byFolder.get(languageFolder);
  if (language === undefined) throw new Error(`no Linguist language has the folder ${languageFolder}`);
  for (const file of files(path.join(samples, languageFolder))) {
    const rel = path.relative(path.join(samples, languageFolder), file);
    // A sample under filenames/ stands for a file of that name; any other keeps its own name.
    const name = rel.startsWith(`filenames${path.sep}`) ? path.basename(file) : rel;
    const text = readFileSync(file, "utf8");
    const found = list.detect(name, () => text).languages;
    if (found.length !== 1) none++;
    else if (found[0] === language) right++;
    else wrong.push(`${path.relative(folder, file)}: ${found[0]}, not ${language}`);
  }
}
console.log(`Linguist ${LINGUIST_RELEASE.tag} samples: ${right + none + wrong.length}; right ${right}, no answer ${none}, wrong ${wrong.length}`);
for (const line of wrong) console.log(`  wrong: ${line}`);
process.exit(wrong.length === 0 ? 0 : 1);
