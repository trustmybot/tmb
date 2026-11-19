// Claude Code's JSON files are the Human's: read them whole, change only tmb's own keys,
// and refuse to touch a file that is not a JSON object rather than overwrite it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The file's object; an absent or blank file reads as {}. Throws when it holds anything else. */
export function readJsonObject(file: string): JsonObject {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error(`${file} does not hold a JSON object`);
  return parsed;
}

export function writeJsonObject(file: string, value: JsonObject): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** Deletes the file, and its folder when that is left empty and is not the project itself. */
export function deleteFile(file: string, projectDir: string): void {
  rmSync(file);
  const dir = path.dirname(file);
  if (path.resolve(dir) !== path.resolve(projectDir) && readdirSync(dir).length === 0) rmdirSync(dir);
}
