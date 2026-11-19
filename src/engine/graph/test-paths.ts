// The test lane: which repo-relative paths hold test code, by the common per-language
// conventions. Carried over from the plugin's defaults.

export type Lane = "test" | "product";

const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "e2e", "fixtures"]);
const TEST_BASENAMES = [/\.(?:test|spec|suite)\./, /_test\.go$/, /^test_.*\.py$/, /_test\.py$/, /_spec\.rb$/, /^conftest\.py$/];

function segmentsOf(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
}

export function isTestPath(path: string): boolean {
  const segments = segmentsOf(path);
  const base = segments.at(-1) ?? "";
  return segments.slice(0, -1).some((s) => TEST_SEGMENTS.has(s)) || TEST_BASENAMES.some((re) => re.test(base));
}

export function laneOf(path: string): Lane {
  return isTestPath(path) ? "test" : "product";
}
