// tmb's release repo, on this machine. The build under test is laid out the way the public
// release repo serves the dev channel, and a small server answers for it, so the real install
// script and tmb's own update both reach it as they would reach GitHub.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dir, "..", "..");

/** The dev build the chain installs, and the newer one offered at the update step. */
export function chainVersions(): { first: string; next: string } {
  const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
  return { first: `${version}-dev.1`, next: `${version}-dev.2` };
}

/** The release asset's name for a platform, as the install script asks for it. */
export function assetName(os: string, arch: string): string {
  return `tmb-${os === "darwin" ? "darwin" : "linux"}-${arch === "arm64" || arch === "aarch64" ? "arm64" : "x64"}`;
}

/**
 * Compiles tmb from this checkout for `target` (such as linux-x64; this machine when null) into
 * `outfile`, stamped with `version`, the way scripts/build.ts does, dashboard styles included.
 * Runs only where the checkout's packages are installed, never in the container.
 */
export async function buildTmb(version: string, outfile: string, target: string | null): Promise<void> {
  const tailwind = (await import("bun-plugin-tailwind")).default;
  mkdirSync(path.dirname(outfile), { recursive: true });
  // Tailwind looks for class names from the folder it runs in, so the build runs in the checkout.
  const cwd = process.cwd();
  process.chdir(ROOT);
  const result = await Bun.build({
    entrypoints: [path.join(ROOT, "src", "cli", "index.ts")],
    compile: { outfile, ...(target ? { target: `bun-${target}` as Bun.Build.CompileTarget } : {}) },
    minify: true,
    define: { TMB_VERSION: JSON.stringify(version), TMB_GIT_SHA: JSON.stringify("chain") },
    plugins: [tailwind],
    throw: false,
  }).finally(() => process.chdir(cwd));
  for (const log of result.logs) console.error(log);
  if (!result.success) throw new Error(`the build of ${version} for ${target ?? "this machine"} failed`);
}

/** Lays `binary` out as the dev channel's release in `releaseDir`, with the install script beside it. */
export function publishDev(releaseDir: string, binary: string, version: string, asset: string): void {
  const dev = path.join(releaseDir, "releases", "download", "dev");
  mkdirSync(dev, { recursive: true });
  copyFileSync(binary, path.join(dev, asset));
  const sum = createHash("sha256").update(readFileSync(binary)).digest("hex");
  writeFileSync(path.join(dev, "SHA256SUMS"), `${sum}  ${asset}\n`);
  writeFileSync(path.join(dev, "VERSION"), `${version}\n`);
  copyFileSync(path.join(ROOT, "scripts", "install.sh"), path.join(dev, "install.sh"));
}

/** Starts the release server on `releaseDir` in its own process; resolves to its address. */
export async function startReleaseServer(releaseDir: string): Promise<{ url: string; stop: () => void }> {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "release-server.ts"), releaseDir], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const read = await reader.read();
    if (read.done) throw new Error("the release server stopped before it said its address");
    text += new TextDecoder().decode(read.value);
  }
  reader.releaseLock();
  const url = text.trim().split("\n")[0]!;
  const stop = () => child.kill();
  process.on("exit", stop);
  return { url, stop };
}
