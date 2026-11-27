// A tool published as a package of the npm registry, the registry the TypeScript compiler and
// pyright publish their releases to (CODE_GRAPH.md, "Where a language's tool comes from"). The
// registry serves one archive of a package's version for every machine: a gzipped tar whose files
// are under `package/`, at `<registry>/<name>/-/<name>-<version>.tgz`, and publishes its integrity,
// a sha512 in base64 (npm's documentation, "package-lock.json", `integrity`).
import type { ToolRelease } from "./contract.ts";

/** The npm registry, and the page of a package's version there. */
const REGISTRY = "https://registry.npmjs.org";
const PAGES = "https://www.npmjs.com/package";
/** The folder of the archive that holds the package's files. */
const PACKAGE_FOLDER = "package/";

/** The release of a package at a version, checked against the sha512 the registry publishes for it, in base64. */
export function npmRelease(name: string, version: string, sha512: string): ToolRelease {
  return {
    version,
    page: `${PAGES}/${name}/v/${version}`,
    assets: {},
    everyMachine: { url: `${REGISTRY}/${name}/-/${name}-${version}.tgz`, sha512, archive: { format: "tgz", from: PACKAGE_FOLDER, to: "" } },
  };
}
