import { useEffect, useState, useCallback } from "react";
import "./App.css";
import {
  getState,
  addCreators,
  onboardCreators,
  updateCapacity,
  getHistory,
  type WaitingListState,
  type HistoryEvent,
} from "./api";

type FlashMessage = { type: "success" | "error"; text: string };

const EVENT_LABELS: Record<HistoryEvent["type"], string> = {
  list_created: "List created",
  creators_added: "Added",
  creators_onboarded: "Onboarded",
  capacity_changed: "Capacity",
};

function historyDetail(e: HistoryEvent): string {
  if (e.type === "list_created") return `capacity ${e.detail?.capacity ?? ""}`;
  if (e.type === "capacity_changed") return `${e.detail?.from} → ${e.detail?.to}`;
  return `${e.count}`;
}

export default function App() {
  const [state, setState] = useState<WaitingListState | null>(null);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [addCount, setAddCount] = useState<string>("1");
  const [onboardCount, setOnboardCount] = useState<string>("1");
  const [capacityInput, setCapacityInput] = useState<string>("");
  const [flash, setFlash] = useState<FlashMessage | null>(null);
  const [loading, setLoading] = useState(false);

  const showFlash = (msg: FlashMessage) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 3000);
  };

  const refresh = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([getState(), getHistory()]);
      setState(s);
      setHistory(h);
      setCapacityInput((prev) => (prev === "" ? String(s.capacity) : prev));
    } catch {
      showFlash({ type: "error", text: "Could not reach backend." });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleAdd = async () => {
    const n = parseInt(addCount, 10);
    if (!Number.isFinite(n) || n < 1) {
      showFlash({ type: "error", text: "Enter a positive integer to add." });
      return;
    }
    setLoading(true);
    try {
      const result = await addCreators(n);
      setState({ cohorts: result.cohorts, total: result.total, capacity: state?.capacity ?? 10 });
      setHistory(await getHistory());
      showFlash({ type: "success", text: `Added ${result.added} creator${result.added !== 1 ? "s" : ""}.` });
    } catch (err) {
      showFlash({ type: "error", text: err instanceof Error ? err.message : "Failed to add." });
    } finally {
      setLoading(false);
    }
  };

  const handleOnboard = async () => {
    const n = parseInt(onboardCount, 10);
    if (!Number.isFinite(n) || n < 1) {
      showFlash({ type: "error", text: "Enter a positive integer to onboard." });
      return;
    }
    if (state?.total === 0) {
      showFlash({ type: "error", text: "Waiting list is empty." });
      return;
    }
    setLoading(true);
    try {
      const result = await onboardCreators(n);
      setState({ cohorts: result.cohorts, total: result.total, capacity: state?.capacity ?? 10 });
      setHistory(await getHistory());
      showFlash({ type: "success", text: `Onboarded ${result.onboarded} creator${result.onboarded !== 1 ? "s" : ""}.` });
    } catch (err) {
      showFlash({ type: "error", text: err instanceof Error ? err.message : "Failed to onboard." });
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateCapacity = async () => {
    const n = parseInt(capacityInput, 10);
    if (!Number.isFinite(n) || n < 1) {
      showFlash({ type: "error", text: "Enter a positive integer capacity." });
      return;
    }
    setLoading(true);
    try {
      const result = await updateCapacity(n);
      setState({ cohorts: result.cohorts, total: result.total, capacity: result.capacity });
      setHistory(await getHistory());
      showFlash({
        type: "success",
        text: result.changed ? `Capacity set to ${result.capacity}; cohorts repacked.` : `Capacity already ${result.capacity}.`,
      });
    } catch (err) {
      showFlash({ type: "error", text: err instanceof Error ? err.message : "Failed to update capacity." });
    } finally {
      setLoading(false);
    }
  };

  const capacity = state?.capacity ?? 10;

  return (
    <div>
      <h1>Waiting List</h1>
      <p className="subtitle">Cohort-based creator queue · capacity {capacity} per cohort</p>

      {flash && <div className={flash.type === "error" ? "error" : "flash"}>{flash.text}</div>}

      <div className="card">
        <h2>Add creators</h2>
        <div className="controls">
          <input
            type="number"
            min={1}
            value={addCount}
            onChange={(e) => setAddCount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <button className="btn btn-primary" onClick={handleAdd} disabled={loading}>
            Add
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Onboard creators</h2>
        <div className="controls">
          <input
            type="number"
            min={1}
            value={onboardCount}
            onChange={(e) => setOnboardCount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleOnboard()}
          />
          <button
            className="btn btn-secondary"
            onClick={handleOnboard}
            disabled={loading || state?.total === 0}
          >
            Onboard
          </button>
        </div>
        <p className="capacity-note">
          Pulls creators off the front of the queue (FIFO) onto the platform. If
          you request more than available, all remaining creators are onboarded.
        </p>
      </div>

      <div className="card">
        <h2>Cohort capacity</h2>
        <div className="controls">
          <input
            type="number"
            min={1}
            value={capacityInput}
            onChange={(e) => setCapacityInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleUpdateCapacity()}
          />
          <button className="btn btn-secondary" onClick={handleUpdateCapacity} disabled={loading}>
            Update
          </button>
        </div>
        <p className="capacity-note">
          Changing capacity repacks everyone waiting into cohorts of the new
          size, preserving queue (FIFO) order.
        </p>
      </div>

      <div className="card">
        <h2>Current state</h2>
        {state === null ? (
          <p className="empty-state">Loading…</p>
        ) : (
          <>
            <div className="total">{state.total}</div>
            <div className="total-label">creators waiting</div>

            <div className="queue" style={{ marginTop: "1.5rem" }}>
              {state.cohorts.length === 0 ? (
                <p className="empty-state">No cohorts — waiting list is empty.</p>
              ) : (
                state.cohorts.map((cohort, i) => {
                  const fillPct = cohort.count / cohort.capacity;
                  const isNewest = i === 0;
                  const isOldest = i === state.cohorts.length - 1;
                  return (
                    <div className="cohort" key={cohort.id}>
                      <span className="cohort-tag">
                        {isNewest && isOldest ? "only" : isNewest ? "new" : isOldest ? "next" : ""}
                      </span>
                      <div className="cohort-bar-wrap">
                        <div
                          className="cohort-bar"
                          style={{ height: `${fillPct * 100}%` }}
                        />
                      </div>
                      <span className="cohort-label">{cohort.count}/{cohort.capacity}</span>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>History</h2>
        {history.length === 0 ? (
          <p className="empty-state">No activity yet.</p>
        ) : (
          <ul className="history">
            {history.map((e) => (
              <li className="history-item" key={e.id}>
                <span className={`history-type history-type-${e.type}`}>
                  {EVENT_LABELS[e.type]}
                </span>
                <span className="history-count">{historyDetail(e)}</span>
                <span className="history-time">
                  {new Date(e.createdAt.replace(" ", "T") + "Z").toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
