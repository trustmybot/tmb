import type { HostAdapter } from "./host-adapter.ts";

/** The host adapters tmb knows, found by host id. */
export class HostRegistry {
  constructor(
    /** Every adapter, in the order hosts are offered. */
    readonly all: readonly HostAdapter[],
    /** The hosts this release supports; another can be set up so its work can be tried. */
    readonly supportedIds: readonly string[],
    /** The host a hook that names none comes from. */
    readonly defaultId: string,
  ) {}

  /** The adapter with the id; throws, naming the hosts tmb knows, when there is none. */
  byId(id: string): HostAdapter {
    const found = this.all.find((adapter) => adapter.id === id);
    if (!found) throw new Error(`unknown host '${id}'; tmb knows ${this.all.map((adapter) => adapter.id).join(", ")}`);
    return found;
  }
}
