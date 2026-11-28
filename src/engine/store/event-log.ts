// The one write path: every write appends one event and applies it to the projections in the
// same transaction. The record's repositories write only through here.
import type { Database } from "bun:sqlite";
import { isId, newId } from "../ids.ts";
import { type Actor, type ActorColumns, actorColumns, actorFromColumns, assertWriter } from "./actor.ts";
import { type EventType, type RecordKind, type StoredEvent, applyEvent, assertValues } from "./projections.ts";
import { PROJECTION_TABLES } from "./schema.ts";

/** Details an entry keeps in its event's data, beyond its columns (trustmybot/tmb#408). */
export type EntryDetail = Record<string, unknown>;

type EventRow = ActorColumns & { id: string; record_kind: RecordKind; record_id: string; type: EventType; data: string; at: string };

/** Drops undefined fields the way the stored JSON will, so the live apply and a rebuild see the same data. */
function asStoredData(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
}

function toEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    recordKind: row.record_kind,
    recordId: row.record_id,
    type: row.type,
    data: JSON.parse(row.data) as Record<string, unknown>,
    actor: actorFromColumns(row),
    at: row.at,
  };
}

/** The current time as the record writes it. */
export function nowIso(): string {
  return new Date().toISOString();
}

export class EventLog {
  private clock: () => string = nowIso;

  constructor(readonly db: Database) {}

  /** Creates a record: appends its created event under `id`, a new one unless given. */
  create(actor: Actor, kind: RecordKind, data: Record<string, unknown>, id: string = newId()): string {
    if (!isId(id)) throw new Error(`a ${kind} id must be a record id, got ${JSON.stringify(id)}`);
    this.append(actor, kind, id, "created", data);
    return id;
  }

  /** Records a change to a record: appends its updated event. */
  update(actor: Actor, recordKind: RecordKind, recordId: string, data: Record<string, unknown>): void {
    this.append(actor, recordKind, recordId, "updated", data);
  }

  /**
   * Appends one event and applies it, in one transaction. The event id is made after the
   * newest stored one, so id order is the order events were applied in, which is the
   * order a rebuild replays them in.
   */
  private append(actor: Actor, recordKind: RecordKind, recordId: string, type: EventType, data: Record<string, unknown>): StoredEvent {
    assertWriter(actor);
    const stored = asStoredData(data);
    assertValues(recordKind, stored);
    return this.db
      .transaction(() => {
        const newest = this.db.query("SELECT max(id) AS id FROM events").get() as { id: string | null };
        const event: StoredEvent = {
          id: newId(newest.id ?? undefined),
          recordKind,
          recordId,
          type,
          data: stored,
          actor,
          at: this.clock(),
        };
        const who = actorColumns(actor);
        this.db
          .query(
            `INSERT INTO events (id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, actor_source, actor_remote, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(event.id, recordKind, recordId, type, JSON.stringify(event.data), who.actor_kind, who.actor_role, who.actor_host, who.actor_source, who.actor_remote ?? null, event.at);
        applyEvent(this.db, { ...event, actor: actorFromColumns(who) });
        return event;
      })
      .immediate();
  }

  /**
   * Runs `work` with every event it writes stamped at `at` instead of now, for records copied
   * from elsewhere that keep the time they were first made. Event ids still follow the newest
   * stored one, so a rebuild replays them in the order they were written.
   */
  backdated<T>(at: string, work: () => T): T {
    if (Number.isNaN(Date.parse(at))) throw new Error(`not a time: ${JSON.stringify(at)}`);
    const before = this.clock;
    this.clock = () => new Date(at).toISOString();
    try {
      return work();
    } finally {
      this.clock = before;
    }
  }

  /** Runs `work` in one transaction: the reads it makes and the records it writes stand or fall together. */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }

  /** Every event of one record, oldest first. */
  history(recordId: string): StoredEvent[] {
    const rows = this.db.query("SELECT * FROM events WHERE record_id = ? ORDER BY id").all(recordId) as EventRow[];
    return rows.map(toEvent);
  }

  /** The kinds of the newest `limit` events, oldest first, as `task updated`; never their content. */
  recentEventKinds(limit: number): string[] {
    const rows = this.db.query("SELECT record_kind, type FROM events ORDER BY id DESC LIMIT ?").all(limit) as { record_kind: string; type: string }[];
    return rows.reverse().map((row) => `${row.record_kind} ${row.type}`);
  }

  /**
   * The events of these record kinds after `afterId`, oldest first, that a Human or the syncer
   * wrote: the changes made outside any agent's chat.
   */
  outsideEvents(afterId: string, kinds: readonly RecordKind[]): StoredEvent[] {
    const marks = kinds.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT * FROM events WHERE id > ? AND record_kind IN (${marks})
         AND (actor_kind = 'human' OR (actor_kind = 'tmb' AND actor_source = 'syncer')) ORDER BY id`,
      )
      .all(afterId, ...kinds) as EventRow[];
    return rows.map(toEvent);
  }

  /** The newest event's id; null for an empty record. */
  newestEventId(): string | null {
    return (this.db.query("SELECT max(id) AS id FROM events").get() as { id: string | null }).id;
  }

  /** When the record's first entry was written; null for an empty record. */
  firstEntryAt(): string | null {
    return (this.db.query("SELECT min(at) AS at FROM events").get() as { at: string | null }).at;
  }

  /** Empties every projection and the search index, then replays all events into them. */
  rebuildProjections(): void {
    this.db
      .transaction(() => {
        for (const table of PROJECTION_TABLES) this.db.run(`DELETE FROM ${table}`);
        this.db.run("DELETE FROM search");
        for (const row of this.db.query("SELECT * FROM events ORDER BY id").iterate() as IterableIterator<EventRow>) {
          applyEvent(this.db, toEvent(row));
        }
      })
      .immediate();
  }
}

/** The actor a projection row names, from its JSON column. */
export function actorOf(column: string): Actor {
  return JSON.parse(column) as Actor;
}
