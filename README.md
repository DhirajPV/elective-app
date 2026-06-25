# Cohort Waiting List

A TypeScript monorepo implementing a FIFO cohort-based waiting list with a React frontend and Express backend.

## Running locally

```bash
# Install all dependencies
npm install

# Terminal 1 — backend (port 3001)
npm run dev:backend

# Terminal 2 — frontend (port 5173)
cd frontend && npm run dev
```

Open http://localhost:5173.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `COHORT_CAPACITY` | `10` | Starting capacity for a brand-new list (reconfigurable at runtime via `PUT /capacity`) |
| `PORT` | `3001` | Backend port |
| `DB_PATH` | `./data/waitinglist.db` | SQLite database file (use `:memory:` for ephemeral) |
| `VITE_API_URL` | `http://localhost:3001` | Backend URL for frontend |

### Tests

```bash
npm test --workspace=backend
```

Runs the suite with Node's built-in test runner (`node:test`). It encodes the
spec walkthrough end-to-end and covers persistence/restart and history.

---

## Structure

```
/
  /backend
    src/
      creator.ts             — Creator entity + factory
      waitingList.ts         — pure queue logic (WaitingList class, no I/O)
      db.ts                  — SQLite persistence (node:sqlite) + history
      waitingListService.ts  — ties the domain model to the database
      index.ts               — Express API
      *.test.ts              — node:test suites (spec walkthrough, persistence)
  /frontend
    src/
      api.ts                 — typed fetch client
      App.tsx                — React UI (add / onboard / history)
```

---

## Design decisions

### Why a backend at all?

The spec says "wrap the system in a simple web page" which reads as frontend-only, but the 4–6 hour estimate implied more. I asked before starting and confirmed a backend was expected.

### WaitingList data model

Cohorts are stored as a plain array, newest at index 0, oldest at the last index — directly mirroring the spec's visual model of `[6, 10]`. This makes `add` (prepend or fill index 0) and `onboard` (drain from the end) straightforward with no reversal logic.

### Creators are a real entity, not a count

Each slot in a cohort is a `Creator` object (`id`, `name`, `handle`, `joinedAt`) rather than a bare count — see [creator.ts](backend/src/creator.ts). A creator represents a real person who will be onboarded, so the model is built to grow (tier, payout details, etc.) without touching the queue logic. The count-only API still works: `POST /creators { count: 5 }` mints five creators with generated placeholder identities, but you can also pass explicit `creators: [{ name, handle }]`.

### "Onboard", not "delete"

This is a queue of creators we pull onto the platform, not a collection we delete from. The operation is therefore `onboard` (`POST /creators/onboard`), and it *returns* the creators it pulled — they leave the queue and are recorded in history with status `onboarded`, never destroyed. The old `DELETE /creators` is gone.

### SQLite as the source of truth

Persistence uses Node's built-in [`node:sqlite`](backend/src/db.ts) — zero native dependencies, real SQL. The database is authoritative: on boot the in-memory `WaitingList` is rehydrated from it ([waitingListService.ts](backend/src/waitingListService.ts)), and every mutation is written back inside a transaction. An append-only `events` table records the full history (`list_created`, `creators_added`, `creators_onboarded`). The domain model ([waitingList.ts](backend/src/waitingList.ts)) stays pure and I/O-free so the queue logic remains trivially unit-testable; the service layer is the only seam that touches the DB.

### Branded type for capacity

```ts
type CohortCapacity = number & { readonly __brand: "CohortCapacity" };
```

`toCohortCapacity()` is the only way to produce one, and it validates at the boundary. This means the type system enforces that you can't accidentally pass an arbitrary integer as a capacity — you have to explicitly validate it first. Not decoration.

### Reconfigurable capacity (repack)

Capacity isn't fixed for the life of the list — `PUT /capacity` changes it at runtime. Each cohort stores its own `capacity`, so the model already supported mixed sizes; on a change we **repack** all waiting creators into cohorts of the new size, preserving FIFO (join) order. The remainder lands in the newest (leftmost) cohort, exactly where `add` would leave a partial cohort, so a subsequent `add` fills it before opening a new one:

```
[8, 10, 10]   set capacity = 5   =>   [3, 5, 5, 5, 5, 5]
```

Setting the same capacity is a no-op (no repack, no history event). The change is persisted and recorded as a `capacity_changed` event.

### `onboard` returning partial results

When you request more creators than available, `onboard` returns however many exist rather than throwing. This matches the spec's intent ("take up to N") and is the more useful behaviour for an ops team pulling from the list.

---

## Edge cases handled

| Case | Handling |
|---|---|
| `add(0)` or `add(-1)` | Throws — must add at least 1 |
| `onboard(0)` or `onboard(-1)` | Throws — must onboard at least 1 |
| `onboard(n)` where n > total | Onboards all available, not an error |
| `add(n)` that exceeds one cohort's capacity | Spills into new cohorts automatically |
| `capacity < 1` | `toCohortCapacity` throws (at construction or on `PUT /capacity`) |
| `PUT /capacity` to the same value | No-op: no repack, no history event (`changed: false`) |
| Repack of an empty list | Capacity updated, no cohorts created |
| Empty list on onboard | Returns `{ onboarded: [], remaining: 0 }` |
| Cohort fully drained | Removed from the list immediately |
| Process restart | State rehydrated from SQLite; nothing lost |
| `GET /history?limit=abc` (non-integer) | `parseInt` returns `NaN`; validated before passing to SQLite, falls back to default limit (50) |

---

## Known limitations & future work

### Single-node only

The in-memory `WaitingList` is the authoritative state between DB writes. On every mutation, the service mutates the in-memory model first, then persists it. This means **two instances of the backend would have independent, immediately diverging queues** — there is no distributed lock, no leader election, and no mechanism for one node to invalidate another's cache.

To scale horizontally you'd need to either: (a) drop the in-memory model and make all reads/writes go directly to the DB, (b) front SQLite with a distributed lock (e.g. Redis `SETNX`), or (c) migrate to a DB with row-level advisory locks (PostgreSQL) and express every mutation as an atomic SQL operation. The current architecture is correct for single-process deployments and survives restarts, but it is not multi-node safe.

### Security considerations

**Authentication & authorization — not implemented.** Any client that can reach the backend can add creators to the queue, onboard them, or reconfigure capacity. In production, `POST /creators/onboard` and `PUT /capacity` are admin-only operations and should sit behind authentication (JWT, session cookie, API key) with role-based access control. Adding creators to the queue would similarly need a verified identity.

**Audit trail without actor.** The `events` table records what happened and when, but not who triggered it. The events schema has room to add a `performed_by` column; once authentication is in place, the service layer can record the acting user's id on every `creators_onboarded` and `capacity_changed` event.

**Input sanitization.** Creator `name` and `handle` are stored and returned as-is — no length cap, no character-set restriction. React's JSX escapes text content on render so XSS isn't directly exploitable in the current frontend, but values would need sanitization before being rendered in any non-React context (emails, webhooks, admin dashboards). The backend also has no rate limiting or request-size cap beyond Express's default 100 kb body limit.

**CORS.** The backend currently allows all origins (`cors()` with no options). In production this should be locked to the frontend's origin.

**SQL injection** is not a risk — all DB operations use parameterized prepared statements throughout.

### Onboard response includes full creator records

`POST /creators/onboard` already returns the full creator objects for every creator pulled off the queue:

```json
{ "onboarded": 3, "creators": [{ "id": "…", "name": "…", "handle": "…", "joinedAt": "…" }], … }
```

The spec treated creators as integers for simplicity, and the frontend only surfaces the count. The data is there if a downstream consumer (webhook, CRM sync, notification service) needs to act on individual creators as they're onboarded.

---

## API

### `GET /state`
Returns full waiting list state (cohorts as counts).

```json
{ "cohorts": [{ "id": "cohort_…", "count": 6, "capacity": 10 }], "total": 6, "capacity": 10 }
```

### `POST /creators`
```json
{ "count": 15 }
```
Adds 15 creators, opening new cohorts as needed. Optionally pass
`{ "count": 1, "creators": [{ "name": "Ada", "handle": "ada" }] }` to set
identities; otherwise placeholders are generated. Returns the created creators.

### `POST /creators/onboard`
```json
{ "count": 5 }
```
Pulls up to 5 creators off the front of the queue (FIFO) and onboards them onto
the platform. Returns the onboarded creator records; the action is recorded in
history. (Replaces the old `DELETE /creators` — this isn't a deletion.)

### `PUT /capacity`
```json
{ "capacity": 5 }
```
Changes the cohort capacity and repacks all waiting creators into cohorts of the
new size (FIFO order preserved). Returns `{ changed, cohorts, total, capacity }`;
`changed` is `false` when the value was already set. Recorded in history.

### `GET /creators/count`
```json
{ "total": 6 }
```

### `GET /history?limit=50`
Returns recorded events, newest first.

```json
{ "events": [{ "id": 7, "type": "creators_onboarded", "count": 5, "detail": { "creators": ["@creator_c3aa"] }, "createdAt": "2026-06-24 23:54:19" }] }
```

---

## AI collaboration

I used Claude throughout this assignment — for the initial build and for the later round of improvements (Creator entity, SQLite persistence, the `onboard` rename, and reconfigurable capacity). What matters is that I made the design calls; the AI accelerated the typing, not the thinking.

### The initial build

**Where it helped:** Scaffolding the monorepo structure, boilerplate Express setup, and the initial React component shell. These are the parts where I know exactly what I want but typing them is mechanical — AI is genuinely faster here.

**Where I overrode it:** The first draft of `WaitingList` stored cohorts oldest-first (index 0 = oldest). I caught this because the spec's visual model is explicitly newest-left, oldest-right, and `[6, 10]` should mean index 0 is the newer cohort. I reversed the storage model and rewrote the add/take logic accordingly. The AI had optimized for "drain from index 0 is fast" without reading the spec carefully enough.

**Where the AI was wrong:** It initially generated `take` to throw when `n > total`. I changed this to return partial results — "take up to N" in the spec implies graceful handling, and throwing here would make the ops UI annoying to use in practice.

**What I wrote by hand:** The branded `CohortCapacity` type and `toCohortCapacity` validation function. I wanted the type system to actually enforce the invariant at the boundary rather than just annotating an `number` as `capacity`. The AI's first pass used a plain `number` with a comment.

### The improvements round

**Where I drove and it followed:** Every architectural fork was my call, not the AI's. I decided the database should be the *source of truth* (state rehydrated on boot) rather than a side audit log; that Creators carry `id + joinedAt + name/handle` so the entity can grow; and — the one with real consequences — that changing capacity should **repack** every waiting creator into new-sized cohorts rather than only affecting future cohorts. The AI implemented these once the decision was made, but it would have happily shipped any of the alternatives.

**Where the AI was sloppy:** Its first pass at the persistence service had a junk line — `void (0 as unknown as _Creator)` next to a duplicate `Creator` import — left in purely to silence an unused-import it had created itself. That's the kind of thing that compiles and passes tests but is indefensible in review, so I deleted it and fixed the imports properly. (Same category: it reached for `@types/node@20`, which predates the `node:sqlite` typings, and its DB row casts skipped the `unknown` step and failed to compile — both caught and corrected.)

**What I reasoned through by hand:** The repack ordering. Re-chunking is easy; getting FIFO order *and* the partial-cohort placement right is the subtle part. I worked out that you flatten oldest-join-first (rightmost cohort first), chunk into the new size, then reverse the chunks so the remainder lands in the newest (leftmost) cohort — which is exactly where `add` leaves a partial cohort, so a later `add` keeps filling it. I encoded that as an explicit test (`[8,10,10] → set 5 → [3,5,5,5,5,5]`, asserting creator ids stay in order) rather than trusting it by eye. I also held the line on keeping `WaitingList` pure and I/O-free, with the service as the only seam that touches SQLite — so the queue logic stays trivially testable regardless of how persistence evolves.
