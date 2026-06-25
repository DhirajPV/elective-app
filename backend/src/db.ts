/**
 * SQLite persistence using Node's built-in `node:sqlite` (no native deps).
 *
 * The database is the source of truth: live state (cohorts + waiting creators)
 * is rehydrated on startup, and every mutation is written here. An append-only
 * `events` table records the full history of what happened to the list.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  Cohort,
  CohortCapacity,
  toCohortCapacity,
  WaitingListSnapshot,
} from "./waitingList";
import { Creator } from "./creator";

export type EventType =
  | "list_created"
  | "creators_added"
  | "creators_onboarded"
  | "capacity_changed";

export interface HistoryEvent {
  id: number;
  type: EventType;
  count: number;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

interface CohortRow {
  id: string;
  capacity: number;
}

interface CreatorRow {
  id: string;
  name: string;
  handle: string;
  joined_at: string;
}

interface EventRow {
  id: number;
  type: EventType;
  count: number;
  detail: string | null;
  created_at: string;
}

export class Database {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    // Ensure the parent directory exists for file-backed databases.
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cohorts (
        id         TEXT PRIMARY KEY,
        capacity   INTEGER NOT NULL,
        position   INTEGER NOT NULL,           -- 0 = newest cohort
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS creators (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        handle       TEXT NOT NULL,
        joined_at    TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'waiting',  -- 'waiting' | 'onboarded'
        cohort_id    TEXT REFERENCES cohorts(id) ON DELETE SET NULL,
        position     INTEGER,                          -- order within cohort
        onboarded_at TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        type       TEXT NOT NULL,
        count      INTEGER NOT NULL,
        detail     TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_creators_cohort ON creators(cohort_id);
    `);
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Returns the configured capacity, or null if the list has never been initialized. */
  getCapacity(): CohortCapacity | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'capacity'")
      .get() as unknown as { value: string } | undefined;
    return row ? toCohortCapacity(Number(row.value)) : null;
  }

  /** Initialize a brand-new list: store its capacity and log the creation event. */
  initList(capacity: CohortCapacity): void {
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('capacity', ?)")
        .run(String(capacity));
      this.insertEvent("list_created", capacity, { capacity });
    });
  }

  /** Rebuild the in-memory snapshot from persisted live state. */
  loadSnapshot(): WaitingListSnapshot | null {
    const capacity = this.getCapacity();
    if (capacity === null) return null;

    const cohortRows = this.db
      .prepare("SELECT id, capacity FROM cohorts ORDER BY position ASC")
      .all() as unknown as CohortRow[];

    const creatorStmt = this.db.prepare(
      "SELECT id, name, handle, joined_at FROM creators WHERE cohort_id = ? AND status = 'waiting' ORDER BY position ASC"
    );

    const cohorts: Cohort[] = cohortRows.map((c) => {
      const creators = (creatorStmt.all(c.id) as unknown as CreatorRow[]).map(toCreator);
      return { id: c.id, capacity: toCohortCapacity(c.capacity), creators };
    });

    return { capacity, cohorts };
  }

  /**
   * Persist the result of an `add`: insert the new creators, reconcile the
   * cohort table to the current live state, and log the event.
   */
  persistAdd(cohorts: ReadonlyArray<Cohort>, added: ReadonlyArray<Creator>): void {
    this.transaction(() => {
      for (const creator of added) {
        this.db
          .prepare(
            "INSERT INTO creators (id, name, handle, joined_at, status) VALUES (?, ?, ?, ?, 'waiting')"
          )
          .run(creator.id, creator.name, creator.handle, creator.joinedAt);
      }
      this.reconcileCohorts(cohorts);
      this.insertEvent("creators_added", added.length, {
        creators: added.map((c) => c.handle),
      });
    });
  }

  /**
   * Persist the result of an `onboard`: flip the onboarded creators' status,
   * reconcile the (possibly shrunk) cohort table, and log the event.
   */
  persistOnboard(cohorts: ReadonlyArray<Cohort>, onboarded: ReadonlyArray<Creator>): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      for (const creator of onboarded) {
        this.db
          .prepare(
            "UPDATE creators SET status = 'onboarded', onboarded_at = ?, cohort_id = NULL, position = NULL WHERE id = ?"
          )
          .run(now, creator.id);
      }
      this.reconcileCohorts(cohorts);
      this.insertEvent("creators_onboarded", onboarded.length, {
        creators: onboarded.map((c) => c.handle),
      });
    });
  }

  /**
   * Persist a capacity change: update the stored capacity, reconcile the
   * repacked cohorts, and log the event.
   */
  persistReconfigure(
    capacity: CohortCapacity,
    cohorts: ReadonlyArray<Cohort>,
    previous: CohortCapacity
  ): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE meta SET value = ? WHERE key = 'capacity'")
        .run(String(capacity));
      this.reconcileCohorts(cohorts);
      this.insertEvent("capacity_changed", capacity, { from: previous, to: capacity });
    });
  }

  /** Most recent history events, newest first. */
  history(limit = 50): HistoryEvent[] {
    const rows = this.db
      .prepare("SELECT id, type, count, detail, created_at FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as EventRow[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      count: r.count,
      detail: r.detail ? JSON.parse(r.detail) : null,
      createdAt: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }

  /**
   * Make the cohorts table (and each waiting creator's cohort assignment)
   * match the current in-memory state. Cohorts no longer present are deleted,
   * which (via ON DELETE SET NULL) detaches any stragglers safely.
   */
  private reconcileCohorts(cohorts: ReadonlyArray<Cohort>): void {
    const keepIds = cohorts.map((c) => c.id);
    const placeholders = keepIds.map(() => "?").join(", ");
    const deleteSql =
      keepIds.length > 0
        ? `DELETE FROM cohorts WHERE id NOT IN (${placeholders})`
        : "DELETE FROM cohorts";
    this.db.prepare(deleteSql).run(...keepIds);

    cohorts.forEach((cohort, position) => {
      this.db
        .prepare(
          `INSERT INTO cohorts (id, capacity, position) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET position = excluded.position`
        )
        .run(cohort.id, cohort.capacity, position);

      cohort.creators.forEach((creator, idx) => {
        this.db
          .prepare("UPDATE creators SET cohort_id = ?, position = ? WHERE id = ?")
          .run(cohort.id, idx, creator.id);
      });
    });
  }

  private insertEvent(type: EventType, count: number, detail: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO events (type, count, detail) VALUES (?, ?, ?)")
      .run(type, count, JSON.stringify(detail));
  }
}

function toCreator(row: CreatorRow): Creator {
  return { id: row.id, name: row.name, handle: row.handle, joinedAt: row.joined_at };
}
