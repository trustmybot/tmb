// The files tmb writes into a host's folders, one per item (a role, a skill): each marked as tmb's,
// rewritten when it differs, left alone when it is not tmb's, and removed when tmb no longer has its item.
// A host gives where each file goes, its text and how it knows its own; the rest is here, once.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deleteFile } from "./json-file.ts";
import { shown } from "./record.ts";

/** The names tmb gives its own files: lowercase letters, digits and hyphens. */
const ITEM_NAME = /^[a-z][a-z0-9-]*$/;

/** Item names in each outcome: written or rewritten, already current, or left alone because the file is not tmb's; and the files removed. */
export type MarkedFilesResult = { written: string[]; current: string[]; notOurs: string[]; removed: string[] };

export abstract class MarkedFiles<Item extends { readonly name: string }> {
  /** `kind` names one item in report lines, such as "role". */
  constructor(protected readonly kind: string) {}

  /** The folder that holds these files in the project. */
  abstract dir(projectDir: string): string;
  /** Where the item's file goes in the project. */
  abstract filePath(projectDir: string, name: string): string;
  /** How each item reads in this project; worked out once per pass. */
  protected abstract textOf(projectDir: string): (item: Item) => string;
  /** Whether tmb wrote the file. */
  protected abstract isOurs(file: string): boolean;
  /** Every file in the folder tmb marked as its own, in the order remove and the gaps report them; `only` picks which. */
  protected abstract ownedFiles(projectDir: string, only: (file: string) => boolean): string[];
  /** What is left to tidy once files were removed. */
  protected afterRemove(_projectDir: string, _removed: readonly string[]): void {}

  write(projectDir: string, items: readonly Item[]): MarkedFilesResult {
    const result: MarkedFilesResult = { written: [], current: [], notOurs: [], removed: [] };
    const textOf = this.textOf(projectDir);
    for (const item of items) {
      if (!ITEM_NAME.test(item.name)) throw new Error(`${this.kind} name ${JSON.stringify(item.name)} must be lowercase letters, digits and hyphens`);
      const file = this.filePath(projectDir, item.name);
      const text = textOf(item);
      if (existsSync(file)) {
        if (!this.isOurs(file)) {
          result.notOurs.push(item.name);
          continue;
        }
        if (readFileSync(file, "utf8") === text) {
          result.current.push(item.name);
          continue;
        }
      }
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      result.written.push(item.name);
    }
    // A file of tmb's for an item this version no longer has goes, as tmb remove would take it.
    const wanted = this.wanted(projectDir, items);
    result.removed = this.remove(projectDir, (file) => !wanted.has(file));
    return result;
  }

  /** Deletes every file tmb marked as its own, or those of them `only` keeps; returns their paths. */
  remove(projectDir: string, only: (file: string) => boolean = () => true): string[] {
    const removed = this.ownedFiles(projectDir, only);
    for (const file of removed) deleteFile(file, projectDir);
    this.afterRemove(projectDir, removed);
    return removed;
  }

  /** What `tmb doctor` finds wrong with these files: one line each, none when init would change nothing. Never writes. */
  gaps(projectDir: string, items: readonly Item[]): string[] {
    const gaps: string[] = [];
    const textOf = this.textOf(projectDir);
    for (const item of items) {
      const file = this.filePath(projectDir, item.name);
      const relative = path.relative(projectDir, file);
      if (!existsSync(file)) gaps.push(`${relative} is missing: the ${item.name} ${this.kind} is not written`);
      else if (!this.isOurs(file)) gaps.push(`${relative} is not tmb's, so the ${item.name} ${this.kind} is not tmb's either; tmb leaves it alone`);
      else if (readFileSync(file, "utf8") !== textOf(item)) gaps.push(`${relative} is not this version's ${item.name} ${this.kind}`);
    }
    const wanted = this.wanted(projectDir, items);
    for (const file of this.ownedFiles(projectDir, (owned) => !wanted.has(owned))) {
      gaps.push(`${path.relative(projectDir, file)} is tmb's ${this.kind} file for a ${this.kind} this version no longer has`);
    }
    return gaps;
  }

  /** Writes the items and says what changed, one line each, for tmb init. */
  setUp(projectDir: string, items: readonly Item[]): string[] {
    const result = this.write(projectDir, items);
    const file = (name: string) => shown(projectDir, this.filePath(projectDir, name));
    return [
      ...result.written.map((name) => `Wrote the ${name} ${this.kind} to ${file(name)}.`),
      ...result.current.map((name) => `${file(name)} already holds the ${name} ${this.kind}; nothing to change.`),
      ...result.notOurs.map((name) => `${file(name)} is not tmb's, so it was kept as it is and the ${name} ${this.kind} was not written.`),
      ...result.removed.map((removed) => `Removed tmb's ${this.kind} file ${shown(projectDir, removed)}, for a ${this.kind} this version no longer has.`),
    ];
  }

  /** Removes every file of tmb's and says so, one line each, for tmb remove. */
  tearDown(projectDir: string): string[] {
    return this.remove(projectDir).map((file) => `Removed tmb's ${this.kind} file ${shown(projectDir, file)}.`);
  }

  private wanted(projectDir: string, items: readonly Item[]): Set<string> {
    return new Set(items.map((item) => this.filePath(projectDir, item.name)));
  }
}
