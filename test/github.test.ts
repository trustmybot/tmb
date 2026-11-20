// Reading origin's address as a GitHub repository: the forms git accepts for a remote, and the
// local paths that name none.
import { describe, expect, test } from "bun:test";
import { parseRemoteUrl } from "../src/engine/github.ts";

const REPO = { host: "github.com", owner: "example", name: "project" };

describe("parseRemoteUrl", () => {
  test("reads https, ssh:// and scp-like addresses, with or without .git", () => {
    expect(parseRemoteUrl("https://github.com/example/project.git")).toEqual(REPO);
    expect(parseRemoteUrl("https://github.com/example/project")).toEqual(REPO);
    expect(parseRemoteUrl("https://token@github.com/example/project.git\n")).toEqual(REPO);
    expect(parseRemoteUrl("ssh://git@github.com/example/project.git")).toEqual(REPO);
    expect(parseRemoteUrl("ssh://git@github.com:22/example/project.git")).toEqual(REPO);
    expect(parseRemoteUrl("git@github.com:example/project.git")).toEqual(REPO);
    expect(parseRemoteUrl("git@ghe.example.com:team/tool")).toEqual({ host: "ghe.example.com", owner: "team", name: "tool" });
  });

  test("a local path or an address with no owner and name is no GitHub repository", () => {
    for (const url of ["/x/y.git", "./x", "../x/y", "C:/x/y.git", "C:x/y", "file:///x/y.git", "https://github.com/example", "", "origin"]) {
      expect(parseRemoteUrl(url)).toBeNull();
    }
  });
});
