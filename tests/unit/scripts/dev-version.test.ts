import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { formatDevVersion, highestStableTag, prNumberFromSubject } from "../../../scripts/dev-version.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

describe("highestStableTag", () => {
  test("compares by SemVer, not by string", () => {
    expect(highestStableTag(["v0.9.0", "v0.10.0", "v0.2.5"])).toBe("v0.10.0");
    expect(highestStableTag(["v1.0.0", "v0.99.99"])).toBe("v1.0.0");
  });

  test("ignores prerelease and other tags", () => {
    expect(highestStableTag(["v0.1.0", "v0.2.0-rc.1", "dev", "0.3.0"])).toBe("v0.1.0");
  });

  test("returns undefined with no stable tag", () => {
    expect(highestStableTag(["v0.1.0-rc.1", "dev", ""])).toBeUndefined();
    expect(highestStableTag([])).toBeUndefined();
  });
});

describe("prNumberFromSubject", () => {
  test("reads a merge commit subject", () => {
    expect(prNumberFromSubject("Merge pull request #26 from trustmybot/feat/mvp-cold-start")).toBe(26);
  });

  test("reads a squash commit subject", () => {
    expect(prNumberFromSubject("⚡ feat(install): put tmb on PATH (#28)")).toBe(28);
  });

  test("returns undefined with no PR number", () => {
    expect(prNumberFromSubject("⚡ feat(install): put tmb on PATH with no manual step")).toBeUndefined();
    expect(prNumberFromSubject("fix #12 in the middle")).toBeUndefined();
  });
});

describe("formatDevVersion", () => {
  test("adds the PR when known", () => {
    expect(formatDevVersion("0.1.0", 17, 28)).toBe("0.1.0-dev.17.gh28");
  });

  test("omits the PR when unknown", () => {
    expect(formatDevVersion("0.1.0", 17)).toBe("0.1.0-dev.17");
  });
});
