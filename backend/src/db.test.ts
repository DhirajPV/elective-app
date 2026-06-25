import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { Database } from "./db";
import { WaitingListService } from "./waitingListService";
import { toCohortCapacity } from "./waitingList";

/** A fresh temp DB path, cleaned up after the test. */
function withTempDb(fn: (path: string) => void) {
  const base = join(tmpdir(), `waitinglist-${randomUUID()}`);
  const path = `${base}.db`;
  try {
    fn(path);
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  }
}

test("state is the DB: it survives a restart", () => {
  withTempDb((path) => {
    // First boot: build up some state.
    const db1 = new Database(path);
    const svc1 = new WaitingListService(db1, toCohortCapacity(10));
    svc1.addCreators(3);
    svc1.addCreators(13);
    svc1.onboard(4);
    const before = svc1.cohorts().map((c) => c.count);
    db1.close();

    // Second boot: same file, state rehydrated from the DB.
    const db2 = new Database(path);
    const svc2 = new WaitingListService(db2, toCohortCapacity(10));
    assert.deepEqual(svc2.cohorts().map((c) => c.count), before);
    assert.equal(svc2.totalCount(), 12);
    db2.close();
  });
});

test("history records every add and onboard", () => {
  withTempDb((path) => {
    const db = new Database(path);
    const svc = new WaitingListService(db, toCohortCapacity(10));
    svc.addCreators(5);
    svc.onboard(2);

    const history = svc.history();
    // newest-first: onboard, add, list_created
    assert.deepEqual(
      history.map((e) => e.type),
      ["creators_onboarded", "creators_added", "list_created"]
    );
    assert.equal(history[0].count, 2);
    assert.equal(history[1].count, 5);
    db.close();
  });
});

test("capacity change is persisted and repacked state survives a restart", () => {
  withTempDb((path) => {
    const db1 = new Database(path);
    const svc1 = new WaitingListService(db1, toCohortCapacity(10));
    svc1.addCreators(28); // => [8, 10, 10]
    const changed = svc1.reconfigureCapacity(5);
    assert.equal(changed, true);
    assert.deepEqual(svc1.cohorts().map((c) => c.count), [3, 5, 5, 5, 5, 5]);

    // No-op when set to the same value.
    assert.equal(svc1.reconfigureCapacity(5), false);
    db1.close();

    // Reboot: capacity and repacked cohorts come back from the DB.
    const db2 = new Database(path);
    const svc2 = new WaitingListService(db2, toCohortCapacity(10));
    assert.equal(svc2.getCapacity(), 5);
    assert.deepEqual(svc2.cohorts().map((c) => c.count), [3, 5, 5, 5, 5, 5]);
    assert.equal(svc2.history()[0].type, "capacity_changed");
    db2.close();
  });
});

test("onboarded creators are persisted as onboarded, not deleted", () => {
  withTempDb((path) => {
    const db = new Database(path);
    const svc = new WaitingListService(db, toCohortCapacity(10));
    svc.addCreators(4);
    const { onboarded } = svc.onboard(3);
    assert.equal(onboarded.length, 3);

    // The onboard event still references the three creators by handle.
    const event = svc.history()[0];
    assert.equal(event.type, "creators_onboarded");
    assert.deepEqual((event.detail as { creators: string[] }).creators, onboarded.map((c) => c.handle));
    db.close();
  });
});
