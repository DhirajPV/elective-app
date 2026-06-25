/**
 * Application service: the seam between the pure domain model (WaitingList)
 * and durable storage (Database). It keeps an in-memory WaitingList hot for
 * fast reads, but the database is the source of truth — on startup the list is
 * rehydrated from it, and every mutation is written back before it returns.
 */

import { Database, HistoryEvent } from "./db";
import { createCreator, Creator, CreatorInput } from "./creator";
import { CohortCapacity, CohortSummary, toCohortCapacity, WaitingList } from "./waitingList";

export class WaitingListService {
  private readonly db: Database;
  private readonly list: WaitingList;

  constructor(db: Database, capacity: CohortCapacity) {
    this.db = db;

    // Source of truth is the DB: hydrate from it, or initialize a fresh list.
    const snapshot = db.loadSnapshot();
    if (snapshot) {
      this.list = WaitingList.fromSnapshot(snapshot);
    } else {
      db.initList(capacity);
      this.list = new WaitingList(capacity);
    }
  }

  /**
   * Add `count` creators. Each is a real Creator record; when only a count is
   * given we generate placeholder identities. Optionally accepts explicit
   * creator details (name/handle).
   */
  addCreators(count: number, details: CreatorInput[] = []): Creator[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Must add at least 1 creator, got: ${count}`);
    }
    const creators = Array.from({ length: count }, (_, i) => createCreator(details[i] ?? {}));
    this.list.add(creators);
    this.db.persistAdd(this.list.snapshot(), creators);
    return creators;
  }

  /** Onboard up to `count` creators off the front of the queue (FIFO). */
  onboard(count: number): { onboarded: Creator[]; remaining: number } {
    const result = this.list.onboard(count);
    this.db.persistOnboard(this.list.snapshot(), result.onboarded);
    return result;
  }

  /**
   * Change the cohort capacity, repacking all waiting creators (see
   * WaitingList.reconfigureCapacity). Returns whether anything changed —
   * setting the same capacity is a no-op (no repack, no history event).
   */
  reconfigureCapacity(newCapacity: number): boolean {
    const cap = toCohortCapacity(newCapacity);
    const previous = this.list.getCapacity();
    if (cap === previous) return false;

    this.list.reconfigureCapacity(cap);
    this.db.persistReconfigure(cap, this.list.snapshot(), previous);
    return true;
  }

  totalCount(): number {
    return this.list.totalCount();
  }

  cohorts(): CohortSummary[] {
    return this.list.summary();
  }

  getCapacity(): CohortCapacity {
    return this.list.getCapacity();
  }

  history(limit?: number): HistoryEvent[] {
    return this.db.history(limit);
  }
}
