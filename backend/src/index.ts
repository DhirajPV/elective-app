import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { toCohortCapacity } from "./waitingList";
import { Database } from "./db";
import { WaitingListService } from "./waitingListService";

const app = express();
app.use(cors());
app.use(express.json());

// Initialize with default capacity of 10; can be overridden via env.
const capacity = toCohortCapacity(
  process.env.COHORT_CAPACITY ? parseInt(process.env.COHORT_CAPACITY, 10) : 10
);

// The SQLite file is the source of truth. State is rehydrated from it on boot.
const db = new Database(process.env.DB_PATH ?? "./data/waitinglist.db");
const service = new WaitingListService(db, capacity);

/**
 * GET /state
 * Returns the full waiting list state: cohorts (as counts), total, capacity.
 */
app.get("/state", (_req: Request, res: Response) => {
  res.json({
    cohorts: service.cohorts(),
    total: service.totalCount(),
    capacity: service.getCapacity(),
  });
});

/**
 * POST /creators
 * Body: { count: number, creators?: { name?, handle? }[] }
 * Adds creators to the waiting list, opening new cohorts as needed.
 */
app.post("/creators", (req: Request, res: Response) => {
  const { count, creators } = req.body;

  if (typeof count !== "number") {
    res.status(400).json({ error: "count must be a number" });
    return;
  }

  const added = service.addCreators(count, Array.isArray(creators) ? creators : []);
  res.json({
    added: added.length,
    creators: added,
    cohorts: service.cohorts(),
    total: service.totalCount(),
  });
});

/**
 * POST /creators/onboard
 * Body: { count: number }
 * Pulls up to `count` creators off the front of the queue (FIFO) and onboards
 * them onto the platform. This is a queue pop, not a deletion — the onboarded
 * creators are returned and recorded in history.
 */
app.post("/creators/onboard", (req: Request, res: Response) => {
  const { count } = req.body;

  if (typeof count !== "number") {
    res.status(400).json({ error: "count must be a number" });
    return;
  }

  const result = service.onboard(count);
  res.json({
    onboarded: result.onboarded.length,
    creators: result.onboarded,
    cohorts: service.cohorts(),
    total: result.remaining,
  });
});

/**
 * PUT /capacity
 * Body: { capacity: number }
 * Changes the cohort capacity and repacks all waiting creators into cohorts of
 * the new size (FIFO order preserved). Returns the new state.
 */
app.put("/capacity", (req: Request, res: Response) => {
  const { capacity: next } = req.body;

  if (typeof next !== "number") {
    res.status(400).json({ error: "capacity must be a number" });
    return;
  }

  const changed = service.reconfigureCapacity(next);
  res.json({
    changed,
    cohorts: service.cohorts(),
    total: service.totalCount(),
    capacity: service.getCapacity(),
  });
});

/**
 * GET /creators/count
 * Returns total number of creators currently waiting.
 */
app.get("/creators/count", (_req: Request, res: Response) => {
  res.json({ total: service.totalCount() });
});

/**
 * GET /history
 * Returns the recorded history of add/onboard events, newest first.
 */
app.get("/history", (req: Request, res: Response) => {
  const raw = parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isInteger(raw) && raw > 0 ? raw : undefined;
  res.json({ events: service.history(limit) });
});

// Global error handler — catches errors thrown from the domain (e.g. invalid input).
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: err.message });
});

const PORT = process.env.PORT ?? 3001;

// Don't start listening when imported by tests.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

export default app;
