/**
 * WaitingList manages a FIFO queue of cohorts of Creators.
 *
 * Cohorts are ordered newest-left, oldest-right.
 * Creators are always added to the newest (leftmost) cohort,
 * and onboarded from the oldest (rightmost) cohort first.
 *
 * Internally we store cohorts as an array where index 0 is the
 * newest cohort and the last index is the oldest — matching the
 * spec's visual model of [6, 10] meaning newer=6, older=10.
 *
 * Each cohort holds actual Creator objects (not just a count), so the
 * model can grow richer over time. `count` is always derived from the
 * number of creators in the cohort.
 */

import { Creator } from "./creator";

export type CohortCapacity = number & { readonly __brand: "CohortCapacity" };

export function toCohortCapacity(n: number): CohortCapacity {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Cohort capacity must be a positive integer, got: ${n}`);
  }
  return n as CohortCapacity;
}

export interface Cohort {
  /** Stable id so a cohort can be tracked across persistence reloads. */
  readonly id: string;
  readonly capacity: CohortCapacity;
  /** Creators in this cohort, ordered oldest-join first. */
  readonly creators: ReadonlyArray<Creator>;
}

/** A cohort flattened for transport/storage — count instead of the creator array. */
export interface CohortSummary {
  readonly id: string;
  readonly count: number;
  readonly capacity: CohortCapacity;
}

export interface OnboardResult {
  /** The creators pulled off the queue, FIFO (oldest join first). */
  onboarded: Creator[];
  /** Total creators still waiting after the operation. */
  remaining: number;
}

/** How a WaitingList can be reconstructed from persisted state. */
export interface WaitingListSnapshot {
  capacity: CohortCapacity;
  cohorts: ReadonlyArray<Cohort>;
}

type IdFactory = () => string;

let cohortSeq = 0;
const defaultCohortId: IdFactory = () => `cohort_${Date.now()}_${cohortSeq++}`;

export class WaitingList {
  private cohorts: Cohort[];
  private capacity: CohortCapacity;
  private readonly newCohortId: IdFactory;

  constructor(
    capacity: CohortCapacity = toCohortCapacity(10),
    newCohortId: IdFactory = defaultCohortId
  ) {
    this.capacity = capacity;
    this.cohorts = [];
    this.newCohortId = newCohortId;
  }

  /**
   * Rebuild a WaitingList from a persisted snapshot (the DB is the source of
   * truth; on startup we hydrate the in-memory model from it).
   */
  static fromSnapshot(
    snapshot: WaitingListSnapshot,
    newCohortId: IdFactory = defaultCohortId
  ): WaitingList {
    const list = new WaitingList(snapshot.capacity, newCohortId);
    list.cohorts = snapshot.cohorts.map((c) => ({ ...c, creators: [...c.creators] }));
    return list;
  }

  /**
   * Add creators to the waiting list.
   * Fills the current newest cohort first, then opens new cohorts as needed.
   * Throws if no creators are supplied.
   */
  add(creators: ReadonlyArray<Creator>): void {
    if (creators.length === 0) {
      throw new Error("Must add at least 1 creator");
    }

    for (const creator of creators) {
      // Open a new cohort if there are none, or the newest is full. We compare
      // against the newest cohort's *own* capacity (cohorts can pre-date a
      // capacity change) and open new cohorts at the current list capacity.
      if (
        this.cohorts.length === 0 ||
        this.cohorts[0].creators.length === this.cohorts[0].capacity
      ) {
        this.cohorts.unshift({
          id: this.newCohortId(),
          capacity: this.capacity,
          creators: [],
        });
      }

      const newest = this.cohorts[0];
      this.cohorts[0] = { ...newest, creators: [...newest.creators, creator] };
    }
  }

  /**
   * Onboard up to `n` creators onto the platform, pulling from the oldest
   * cohorts first (FIFO). They leave the queue and are returned to the caller.
   *
   * If n exceeds the number waiting, onboards however many are available —
   * not an error. Throws if n < 1. Cohorts emptied this way are removed.
   */
  onboard(n: number): OnboardResult {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Must onboard at least 1 creator, got: ${n}`);
    }

    const onboarded: Creator[] = [];

    while (onboarded.length < n && this.cohorts.length > 0) {
      const oldestIndex = this.cohorts.length - 1;
      const oldest = this.cohorts[oldestIndex];
      const want = n - onboarded.length;

      if (oldest.creators.length <= want) {
        // Drain the entire cohort and remove it.
        onboarded.push(...oldest.creators);
        this.cohorts.pop();
      } else {
        // Partially drain the oldest cohort, taking the earliest joiners.
        onboarded.push(...oldest.creators.slice(0, want));
        this.cohorts[oldestIndex] = { ...oldest, creators: oldest.creators.slice(want) };
      }
    }

    return { onboarded, remaining: this.totalCount() };
  }

  /**
   * Change the cohort capacity and repack all waiting creators into cohorts of
   * the new size, preserving FIFO (join) order. The remainder lands in the
   * newest (leftmost) cohort, matching how `add` leaves a partial cohort at the
   * front. Existing cohort ids are replaced since the grouping changes.
   */
  reconfigureCapacity(newCapacity: CohortCapacity): void {
    // Flatten waiting creators oldest-join-first: oldest cohort (last index)
    // first, and within each cohort creators are already oldest-first.
    const inJoinOrder: Creator[] = [];
    for (let i = this.cohorts.length - 1; i >= 0; i--) {
      inJoinOrder.push(...this.cohorts[i].creators);
    }

    this.capacity = newCapacity;

    // Re-chunk oldest-first so any partial chunk is the newest creators...
    const chunks: Creator[][] = [];
    for (let i = 0; i < inJoinOrder.length; i += newCapacity) {
      chunks.push(inJoinOrder.slice(i, i + newCapacity));
    }

    // ...then lay out newest-first, putting that partial chunk at index 0.
    this.cohorts = chunks.reverse().map((creators) => ({
      id: this.newCohortId(),
      capacity: newCapacity,
      creators,
    }));
  }

  /** Total number of creators currently waiting. */
  totalCount(): number {
    return this.cohorts.reduce((sum, c) => sum + c.creators.length, 0);
  }

  /** Full state — newest cohort first, with creator objects. */
  snapshot(): ReadonlyArray<Cohort> {
    return this.cohorts;
  }

  /** Lightweight state for transport — counts instead of creator arrays. */
  summary(): CohortSummary[] {
    return this.cohorts.map((c) => ({
      id: c.id,
      count: c.creators.length,
      capacity: c.capacity,
    }));
  }

  /** Cohort capacity this list was configured with. */
  getCapacity(): CohortCapacity {
    return this.capacity;
  }
}
