// Copies GitHub Linguist's data files, unedited, from a checkout of one Linguist release into
// src/engine/linguist/data/, and records the release and each file's SHA-256 in RELEASE.json
// (trustmybot/tmb#154). The build puts the files into the compiled tmb, as it does the bug form; tmb
// keeps no language list of its own and never runs Linguist, which is a Ruby program.
//
//   git clone --depth 1 --branch <tag> https://github.com/github-linguist/linguist <dir>
//   bun scripts/linguist.ts <dir> <tag> <40-character commit of the tag>
//
// Linguist is MIT licensed; its LICENSE is copied beside the data.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LINGUIST_FILES } from "../src/engine/linguist/files.ts";

const [checkout, tag, commit] = process.argv.slice(2);
if (!checkout || !tag || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error("usage: bun scripts/linguist.ts <linguist checkout> <release tag> <40-character commit>");
  process.exit(2);
}

const out = path.join(import.meta.dir, "..", "src", "engine", "linguist", "data");
mkdirSync(out, { recursive: true });
const files: Record<string, string> = {};
for (const file of LINGUIST_FILES) {
  const from = path.join(checkout, file === "LICENSE" ? "" : path.join("lib", "linguist"), file);
  if (!existsSync(from)) {
    console.error(`${from} is missing: is ${checkout} a checkout of Linguist?`);
    process.exit(1);
  }
  copyFileSync(from, path.join(out, file));
  files[file] = createHash("sha256").update(readFileSync(from)).digest("hex");
}
writeFileSync(path.join(out, "RELEASE.json"), `${JSON.stringify({ repo: "github-linguist/linguist", tag, commit, licence: "MIT", files }, null, 1)}\n`);
console.log(`copied ${LINGUIST_FILES.length} files of Linguist ${tag} to ${out}`);
