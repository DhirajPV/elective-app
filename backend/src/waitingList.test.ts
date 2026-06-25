import { test } from "node:test";
import assert from "node:assert/strict";
import { WaitingList, toCohortCapacity } from "./waitingList";
import { createCreator } from "./creator";

/** Helper: build n placeholder creators. */
const make = (n: number) => Array.from({ length: n }, () => createCreator());

/** Helper: cohort fill counts, newest-first — the spec's visual model. */
const counts = (list: WaitingList) => list.snapshot().map((c) => c.creators.length);

test("spec walkthrough: add / onboard / totals", () => {
  const list = new WaitingList(toCohortCapacity(10));

  // Create a waiting list (capacity 10) => []
  assert.deepEqual(counts(list), []);

  // Add 3 creators => [3]
  list.add(make(3));
  assert.deepEqual(counts(list), [3]);

  // Add 13 creators (7 fill the existing cohort; 6 open a new cohort) => [6, 10]
  list.add(make(13));
  assert.deepEqual(counts(list), [6, 10]);

  // Add 22 creators (6-cohort fills to 10; 18 open two new cohorts) => [8, 10, 10, 10]
  list.add(make(22));
  assert.deepEqual(counts(list), [8, 10, 10, 10]);

  // Take 4 (FIFO — pull from the right) => [8, 10, 10, 6]
  assert.equal(list.onboard(4).onboarded.length, 4);
  assert.deepEqual(counts(list), [8, 10, 10, 6]);

  // Take 7 => [8, 10, 9]
  assert.equal(list.onboard(7).onboarded.length, 7);
  assert.deepEqual(counts(list), [8, 10, 9]);

  // Total waiting => 27
  assert.equal(list.totalCount(), 27);

  // Take 20 => [7]
  assert.equal(list.onboard(20).onboarded.length, 20);
  assert.deepEqual(counts(list), [7]);

  // Total waiting => 7
  assert.equal(list.totalCount(), 7);
});

test("onboard is FIFO across cohorts and within a cohort (oldest joiners first)", () => {
  const list = new WaitingList(toCohortCapacity(10));
  const first = make(3);
  const second = make(3);
  list.add(first); // joins first, ends up in the oldest cohort
  list.add(second);

  // All 6 sit in one cohort [6]; onboard 4 should pull the 3 earliest, then 1 more.
  const { onboarded } = list.onboard(4);
  assert.deepEqual(
    onboarded.map((c) => c.id),
    [first[0].id, first[1].id, first[2].id, second[0].id]
  );
});

test("onboard more than available returns all, not an error", () => {
  const list = new WaitingList(toCohortCapacity(10));
  list.add(make(5));
  const { onboarded, remaining } = list.onboard(100);
  assert.equal(onboarded.length, 5);
  assert.equal(remaining, 0);
  assert.deepEqual(counts(list), []);
});

test("reconfigureCapacity repacks waiting creators, preserving FIFO order", () => {
  const list = new WaitingList(toCohortCapacity(10));
  list.add(make(28)); // => [8, 10, 10]
  assert.deepEqual(counts(list), [8, 10, 10]);

  // Capture global join order (oldest-first) before the repack.
  const joinOrderBefore = list
    .snapshot()
    .slice()
    .reverse()
    .flatMap((c) => c.creators.map((cr) => cr.id));

  list.reconfigureCapacity(toCohortCapacity(5));

  // 28 creators in chunks of 5, remainder (3) in the newest (leftmost) cohort.
  assert.deepEqual(counts(list), [3, 5, 5, 5, 5, 5]);
  assert.equal(list.getCapacity(), 5);
  assert.equal(list.totalCount(), 28);

  // Order is unchanged: same ids, same FIFO sequence.
  const joinOrderAfter = list
    .snapshot()
    .slice()
    .reverse()
    .flatMap((c) => c.creators.map((cr) => cr.id));
  assert.deepEqual(joinOrderAfter, joinOrderBefore);
});

test("reconfigureCapacity then add fills the repacked partial cohort first", () => {
  const list = new WaitingList(toCohortCapacity(10));
  list.add(make(12)); // => [2, 10]
  list.reconfigureCapacity(toCohortCapacity(4)); // 12 => [4, 4, 4]
  assert.deepEqual(counts(list), [4, 4, 4]);

  list.reconfigureCapacity(toCohortCapacity(5)); // 12 => [2, 5, 5]
  assert.deepEqual(counts(list), [2, 5, 5]);

  list.add(make(1)); // fills the newest cohort (2 -> 3), no new cohort
  assert.deepEqual(counts(list), [3, 5, 5]);
});

test("reconfigureCapacity on an empty list just changes capacity", () => {
  const list = new WaitingList(toCohortCapacity(10));
  list.reconfigureCapacity(toCohortCapacity(3));
  assert.deepEqual(counts(list), []);
  assert.equal(list.getCapacity(), 3);
  list.add(make(4)); // => [1, 3]
  assert.deepEqual(counts(list), [1, 3]);
});

test("invalid inputs throw", () => {
  const list = new WaitingList(toCohortCapacity(10));
  assert.throws(() => list.add([]));
  assert.throws(() => list.onboard(0));
  assert.throws(() => list.onboard(-1));
  assert.throws(() => toCohortCapacity(0));
  assert.throws(() => toCohortCapacity(1.5));
});
