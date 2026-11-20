import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ASSETS, downloadBase, isCurrent, namesOf, parseSums, publish, renderManifests, writeManifests } from "../scripts/package-managers.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tmb-pm-test-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A release's SHA256SUMS as the release workflows write it, with a distinct checksum per file. */
function sampleSums(): string {
  const files = [...Object.keys(ASSETS), "install.sh", "install.ps1", "VERSION"];
  return files.map((file, i) => `${String(i + 1).repeat(64).slice(0, 63)}${"abcdef0123456789"[i]}  ${file}`).join("\n") + "\n";
}
const SUMS = parseSums(sampleSums());

const RELEASES = "https://github.com/trustmybot/tmb-releases";
const CASES = [
  { version: "1.2.3", channel: "stable", program: "tmb", cask: "tmb", winget: "TrustMyBot.tmb", download: `${RELEASES}/releases/download/v1.2.3` },
  { version: "1.2.3-rc.4", channel: "rc", program: "tmb-rc", cask: "tmb@rc", winget: "TrustMyBot.tmb.RC", download: `${RELEASES}/releases/download/v1.2.3-rc.4` },
  { version: "1.2.3-dev.5.gh90", channel: "dev", program: "tmb-dev", cask: "tmb@dev", winget: "TrustMyBot.tmb.Dev", download: `${RELEASES}/releases/download/dev` },
] as const;

describe("parseSums", () => {
  test("reads sha256sum's text and binary lines and ignores the rest", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const sums = parseSums(`${a}  tmb-linux-x64\n${b} *tmb-windows-x64.exe\nnot a line\n\n`);
    expect([...sums]).toEqual([
      ["tmb-linux-x64", a],
      ["tmb-windows-x64.exe", "b".repeat(64)],
    ]);
  });
});

describe("renderManifests", () => {
  for (const c of CASES) {
    describe(`${c.channel} (${c.version})`, () => {
      const manifests = renderManifests(c.version, SUMS);
      const wingetDir = `winget/manifests/t/${c.winget.split(".").join("/")}/${c.version}`;

      test("installs under the channel's own program name, so the channels sit side by side", () => {
        expect(namesOf(c.channel)).toMatchObject({ program: c.program, cask: c.cask, wingetId: c.winget });
        expect(Object.keys(manifests).sort()).toEqual(
          [
            `homebrew/Casks/${c.cask}.rb`,
            `scoop/bucket/${c.program}.json`,
            `${wingetDir}/${c.winget}.installer.yaml`,
            `${wingetDir}/${c.winget}.locale.en-US.yaml`,
            `${wingetDir}/${c.winget}.yaml`,
          ].sort(),
        );
      });

      test("leaves no placeholder unfilled", () => {
        for (const content of Object.values(manifests)) expect(content).not.toMatch(/\{\{|\}\}/);
      });

      test("the cask names every platform's file with its checksum and leaves updates to tmb", () => {
        const cask = manifests[`homebrew/Casks/${c.cask}.rb`]!;
        expect(cask).toContain(`cask "${c.cask}" do`);
        expect(cask).toContain(`version "${c.version}"`);
        expect(cask).toMatch(/^\s*auto_updates true$/m);
        for (const asset of ["tmb-darwin-arm64", "tmb-darwin-x64", "tmb-linux-arm64", "tmb-linux-x64"]) {
          // Homebrew wants sha256 before url inside an on_<arch> block.
          expect(cask).toContain(`sha256 "${SUMS.get(asset)}"\n      url "${c.download}/${asset}"`);
        }
        // The file itself takes the program's name, since a program knows itself by its file's name, not a symlink's.
        expect(cask).toContain(`File.rename(file, "#{staged_path}/${c.program}")`);
        expect(cask).toMatch(new RegExp(`^  binary "${c.program}"$`, "m"));
        expect(cask).toContain(`Run \`${c.program} init\``);
        expect(cask).not.toContain("windows");
      });

      test("the Scoop manifest installs the Windows file as the program", () => {
        const scoop = JSON.parse(manifests[`scoop/bucket/${c.program}.json`]!);
        expect(scoop.version).toBe(c.version);
        expect(scoop.architecture["64bit"]).toEqual({ url: `${c.download}/tmb-windows-x64.exe#/${c.program}.exe`, hash: SUMS.get("tmb-windows-x64.exe") });
        expect(scoop.bin).toBe(`${c.program}.exe`);
        expect(scoop.license.identifier).toBe("FSL-1.1-ALv2");
      });

      test("the winget manifests are one package per channel, portable, and leave updates to tmb", () => {
        const version = Bun.YAML.parse(manifests[`${wingetDir}/${c.winget}.yaml`]!) as Record<string, unknown>;
        const installer = Bun.YAML.parse(manifests[`${wingetDir}/${c.winget}.installer.yaml`]!) as Record<string, any>;
        const locale = Bun.YAML.parse(manifests[`${wingetDir}/${c.winget}.locale.en-US.yaml`]!) as Record<string, unknown>;
        for (const manifest of [version, installer, locale]) {
          expect(manifest.PackageIdentifier).toBe(c.winget);
          expect(String(manifest.PackageVersion)).toBe(c.version);
          expect(manifest.ManifestVersion).toBe("1.10.0");
        }
        expect(version).toMatchObject({ ManifestType: "version", DefaultLocale: "en-US" });
        expect(installer).toMatchObject({ ManifestType: "installer", InstallerType: "portable", Commands: [c.program], UpgradeBehavior: "deny" });
        expect(installer.Installers).toEqual([
          { Architecture: "x64", InstallerUrl: `${c.download}/tmb-windows-x64.exe`, InstallerSha256: SUMS.get("tmb-windows-x64.exe")!.toUpperCase() },
        ]);
        expect(locale).toMatchObject({ ManifestType: "defaultLocale", PackageLocale: "en-US", License: "FSL-1.1-ALv2", Moniker: c.program });
        for (const field of ["Publisher", "PackageName", "ShortDescription"]) expect(locale[field]).toBeTruthy();
      });
    });
  }

  test("refuses a release whose SHA256SUMS lacks a platform's file", () => {
    const sums = new Map(SUMS);
    sums.delete("tmb-linux-arm64");
    expect(() => renderManifests("1.0.0", sums)).toThrow("tmb-linux-arm64");
  });

  test("refuses a version that is not a release's", () => {
    for (const version of ["v1.0.0", "1.0", "1.0.0-beta.1", "dev", ""]) expect(() => renderManifests(version, SUMS)).toThrow("not a tmb release version");
  });

  test("points at another release repo when told to", () => {
    expect(downloadBase("1.0.0", "http://127.0.0.1:9/r/")).toBe("http://127.0.0.1:9/r/releases/download/v1.0.0");
    expect(renderManifests("1.0.0", SUMS, "http://127.0.0.1:9/r")["scoop/bucket/tmb.json"]).toContain("http://127.0.0.1:9/r/releases/download/v1.0.0/tmb-windows-x64.exe");
  });

  test("the CLI writes every manifest from a SHA256SUMS file", () => {
    const dir = temp();
    writeFileSync(path.join(dir, "SHA256SUMS"), sampleSums());
    const result = spawnSync("bun", [path.join(import.meta.dir, "..", "scripts", "package-managers.ts"), "render", "2.0.0-rc.1", path.join(dir, "SHA256SUMS"), path.join(dir, "out")], { encoding: "utf8" });
    expect(result.status).toBe(0);
    for (const file of Object.keys(renderManifests("2.0.0-rc.1", SUMS))) expect(existsSync(path.join(dir, "out", file))).toBe(true);
  });
});

describe("isCurrent", () => {
  // A stand-in for the public release repo: dev and stable read a VERSION file, rc reads the releases API.
  const versions: Record<string, string> = { dev: "1.1.0-dev.7.gh20", latest: "1.0.1" };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/releases/download/dev/VERSION") return new Response(`${versions.dev}\n`);
      if (url.pathname === "/releases/latest/download/VERSION") return new Response(`${versions.latest}\n`);
      if (url.pathname === "/api/releases") return Response.json([{ tag_name: "v1.1.0-rc.2", draft: false }, { tag_name: "v1.1.0-rc.10", draft: false }, { tag_name: "v1.1.0-rc.11", draft: true }]);
      return new Response("not found", { status: 404 });
    },
  });
  afterAll(() => server.stop(true));
  const env = { TMB_RELEASES_URL: server.url.origin, TMB_RELEASES_API: `${server.url.origin}/api` };

  test("dev is current only while it is the rolling release's build", async () => {
    expect(await isCurrent("1.1.0-dev.7.gh20", env)).toBe(true);
    expect(await isCurrent("1.1.0-dev.6.gh19", env)).toBe(false);
  });

  test("a stable release on an older line never replaces the newest stable", async () => {
    expect(await isCurrent("1.0.1", env)).toBe(true);
    expect(await isCurrent("1.0.0", env)).toBe(false);
    expect(await isCurrent("0.9.9", env)).toBe(false);
  });

  test("rc is current when no published rc is newer", async () => {
    expect(await isCurrent("1.1.0-rc.10", env)).toBe(true);
    expect(await isCurrent("1.1.0-rc.2", env)).toBe(false);
  });
});

describe("publish", () => {
  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** A bare repo at <base>/<owner>/<name>.git with one commit, as a freshly created tap would have. */
  function remoteRepo(base: string, repo: string): string {
    const bare = path.join(base, `${repo}.git`);
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--quiet", "--bare");
    const seed = temp();
    git(seed, "init", "--quiet");
    writeFileSync(path.join(seed, "README.md"), "tap\n");
    git(seed, "add", "README.md");
    git(seed, "commit", "--quiet", "-m", "init");
    git(seed, "push", "--quiet", bare, "HEAD:refs/heads/main");
    git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
    return bare;
  }

  function manifestsDir(version: string): string {
    const out = temp();
    writeManifests(out, renderManifests(version, SUMS));
    return path.join(out, "homebrew");
  }

  test("skips, without failing, when the token is missing", () => {
    expect(publish("trustmybot/homebrew-tmb", manifestsDir("1.0.0"), { token: "", message: "m" })).toEqual({
      status: "skipped",
      reason: "TMB_PACKAGING_TOKEN is not set, so trustmybot/homebrew-tmb was not updated",
    });
    expect(publish("trustmybot/homebrew-tmb", manifestsDir("1.0.0"), { message: "m" }).status).toBe("skipped");
  });

  test("skips, without failing, when the repo does not exist", () => {
    const result = publish("trustmybot/homebrew-tmb", manifestsDir("1.0.0"), { token: "t", remoteBase: temp(), message: "m" });
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("does not exist");
  });

  test("pushes the manifests as one commit, and nothing when they are already there", () => {
    const base = temp();
    const bare = remoteRepo(base, "trustmybot/homebrew-tmb");
    const dir = manifestsDir("1.0.0");
    expect(publish("trustmybot/homebrew-tmb", dir, { token: "t", remoteBase: base, message: "tmb 1.0.0" }).status).toBe("pushed");
    expect(git(bare, "log", "--format=%s", "main")).toBe("tmb 1.0.0\ninit");
    expect(git(bare, "show", "main:Casks/tmb.rb")).toBe(readFileSync(path.join(dir, "Casks", "tmb.rb"), "utf8").trimEnd());
    expect(publish("trustmybot/homebrew-tmb", dir, { token: "t", remoteBase: base, message: "again" }).status).toBe("unchanged");
  });

  test("keeps the other channels' manifests when one channel updates", () => {
    const base = temp();
    const bare = remoteRepo(base, "trustmybot/homebrew-tmb");
    for (const c of CASES) publish("trustmybot/homebrew-tmb", manifestsDir(c.version), { token: "t", remoteBase: base, message: c.version });
    expect(publish("trustmybot/homebrew-tmb", manifestsDir("1.2.4"), { token: "t", remoteBase: base, message: "1.2.4" }).status).toBe("pushed");
    expect(git(bare, "ls-tree", "--name-only", "main", "Casks/").split("\n").sort()).toEqual(["Casks/tmb.rb", "Casks/tmb@dev.rb", "Casks/tmb@rc.rb"]);
    expect(git(bare, "show", "main:Casks/tmb.rb")).toContain('version "1.2.4"');
    expect(git(bare, "show", "main:Casks/tmb@rc.rb")).toContain('version "1.2.3-rc.4"');
  });
});
