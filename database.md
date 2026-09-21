# Database

Postgres (Neon). The DDL lives in **[`db/migrations/0001_init.sql`](db/migrations/0001_init.sql)**, which is the source of truth.
This file explains it. **[`db/schema.test.mjs`](db/schema.test.mjs)** proves every rule in the database itself: 36 cases,
covering both sides of each edge, run in-process with PGlite (`node db/schema.test.mjs`).

Rules R1–R6 are defined in [manual.md](manual.md). Hosting is in [infrastructure.md](infrastructure.md).

## 1. Relational or not?

**Relational.** The data is a handful of entities (project, berth, vessel, booking) with hard relationships between them,
and rules that span rows:

| Need | Relational DB | Document DB (e.g. MongoDB) |
|---|---|---|
| Booking → berth, booking → vessel must point at something real (in the same project) | foreign keys | app code only |
| "No two bookings on a berth share a day" (compares *rows*) | `EXCLUDE` constraint, checked atomically | app code; racy without extra locking |
| Check-then-insert as one atomic step | transactions | limited, per-document by default |
| Ad-hoc questions ("which berths are free 3–9 March for 120′?") | one SQL query | aggregation pipelines |
| Schema flexibility | not needed: the shape is fixed and known | the main selling point, and we don't need it |

The whole point of the project is *invariants*, and invariants are what relational databases are built to enforce.

## 2. Why Postgres

| | SQLite | Postgres |
|---|---|---|
| Hosting live on Vercel | ✗ serverless disk is ephemeral and every instance has its own | ✔ Neon: managed, free tier |
| Overlap rules R2, R4 | hand-written triggers, twice each (insert + update) | **declarative**: `daterange` + `EXCLUDE USING gist`, one line each |
| Concurrent writes | one writer | real concurrency; the constraint decides who wins (backend.md §8) |
| Dates | `TEXT` + `CHECK (date(x) IS x)` | a real `date` type: `2026-02-30` is rejected natively |

SQLite was the first draft, chosen when "the reviewer runs it locally" was the plan. A live demo changed that.

## 3. Entities

```
                         ┌──────────────────┐
                         │     project      │   a workspace: the sample, a copy of the defaults, or your own
                         │ id PK            │   template_key ≠ NULL → a read-only template, cloned, never edited
                         │ name, origin     │
                         │ template_key UQ  │
                         │ as_of_date       │   "today" override (was the setting table)
                         └───┬──────────┬───┘
                   1         │          │         1
             ┌───────────────┘          └───────────────┐
             │ *                                      * │
      ┌──────┴───────┐                          ┌───────┴───────┐
      │    berth     │                          │    vessel     │
      │ id PK        │                          │ id PK         │
      │ project_id FK│                          │ project_id FK │
      │ name  UQ/proj│                          │ name UQ/proj  │
      │ kind         │                          │ length_ft     │
      │ length_ft    │                          │ draft_ft, …   │
      │ active, sort │                          └───────┬───────┘
      └──────┬───────┘                                  │ 0..1
             │ 1         ┌────────────────────────┐   * │
             └─────────* ┤        booking         ├─────┘
                         │ id PK                  │
                         │ project_id  ┐          │  (project_id, berth_id, berth_kind) → berth
                         │ berth_id    ├ one FK   │  (project_id, vessel_id)            → vessel
                         │ berth_kind  ┘          │
                         │ occupant_type          │  vessel → vessel_id set, title NULL
                         │ vessel_id NULL         │  event / closure → vessel_id NULL, title set
                         │ title NULL             │
                         │ start_date, end_date   │  INCLUSIVE both ends
                         │ period (generated)     │  daterange(start, end, '[]'), for the EXCLUDE constraints
                         │ status, source, notes  │
                         │ version, created/updated│
                         └────────────────────────┘

  project 1 ─ * import_run 1 ─ * import_staged_berth   (berths the file defines)
                           1 ─ * import_staged_vessel
                           1 ─ * import_staged_booking → an existing berth XOR a staged one
                           1 ─ * import_issue
```

Events and closures are **not** a separate table. They have no attributes of their own beyond a title, and each one happens once.

## 4. Schema walkthrough

### Types

| Thing | Type | Why |
|---|---|---|
| ids | `uuid`, `gen_random_uuid()` | built in (PG 13+); safe to generate in app or DB |
| booking days | `date` | a calendar day, no time and no zone. Invalid dates are rejected by the type |
| lengths | `numeric(6,1)` | exact decimals (`410.0`, `24.5`), no float drift in `>` comparisons |
| audit times | `timestamptz` | real instants: `created_at`, `import_run.committed_at` |
| enums | `text` + `CHECK (x IN …)` | easier to extend in a migration than `CREATE TYPE … AS ENUM` |

### Project scoping

Every berth, vessel, booking and import belongs to one project, and `ON DELETE CASCADE` from `project` removes all of it.
Names are unique **per project**, ignoring case: `UNIQUE INDEX … (project_id, lower(name))`.

A booking can't point into another project. `booking` carries `project_id`, and its foreign keys are **composite**:
`(project_id, berth_id, …) → berth (project_id, id, …)`. A berth id from project B paired with project A's id matches no row.

### Where each rule lives

The service (`rules.ts`) checks every rule first, so it can return good messages with the ids of the blocking bookings.
The database enforces the same rules again, so a bug, a second writer or a hand-typed SQL statement still can't break
them. **A database error in normal operation means the service has a bug.**

| Rule | Service | Database | Constraint name → API code |
|---|---|---|---|
| R1 valid range | ✔ | `date` type + `CHECK` | `booking_range_valid` → `INVALID_RANGE` |
| R2 no overlap (berths, not sections) | ✔ | `EXCLUDE (berth_id =, period &&) WHERE confirmed AND berth_kind='berth'` | `booking_no_overlap` → `OVERLAP` |
| R3 vessel fits | ✔ | trigger `booking_fit` | `booking_fit` → `VESSEL_TOO_LONG` |
| R4 one place at a time | ✔ | `EXCLUDE (vessel_id =, period &&) WHERE confirmed` | `booking_vessel_once` → `VESSEL_DOUBLE_BERTHED` |
| R5 inactive berth takes no *new* bookings | ✔ | – (a policy about new rows; existing ones stay valid) | |
| R6 length edits can't break bookings | ✔ (lists them) | triggers `vessel_length_guard`, `berth_length_guard` | → `VESSEL_TOO_LONG` |
| Same project | – | composite FKs | `booking_berth_fk`, `booking_vessel_fk` |
| Delete only if unreferenced | ✔ (says how many) | FK, `NO ACTION` | `booking_berth_fk` / `booking_vessel_fk` on `DELETE` |
| Berth kind fixed once booked | ✔ (not in `BerthPatch`) | the same composite FK: changing `kind` orphans its bookings | `booking_berth_fk` |
| Unknown vessel length (manual) | ✔ | – (NULL passes the trigger; imports need it) | |
| Horizon (2y warn / 5y block) | ✔ | – (policy; relative to a movable "today") | |

The app maps errors **by constraint name** (`err.constraint`), never by message text. The triggers raise with
`USING CONSTRAINT = '…'`, so all rule errors look the same to the error handler.

### Two decisions the tests forced

1. **`period` is `CASE WHEN start_date <= end_date THEN daterange(…) END`.** Without the `CASE`, a reversed range makes
   the *generated column* throw a generic `22000` before the `CHECK` runs, so the error loses its name. The test caught this.
2. **Foreign keys are `NO ACTION`, not `RESTRICT`.** `RESTRICT` fires immediately, so deleting a project would fail as
   soon as the cascade reached a berth that still has bookings. `NO ACTION` checks at the end of the statement, after the
   cascade has also removed the bookings. A direct `DELETE FROM berth` with bookings still fails.

## 5. Normalisation (BCNF)

**The test:** a table is in Boyce–Codd Normal Form when, for every non-trivial functional dependency `X → Y`,
**X is a superkey**. If a non-key determines another column, that fact is stored once per row, and copies can disagree.

| Table | Candidate keys | BCNF? |
|---|---|---|
| `project` | `id`, `template_key` (when not NULL) | ✔ |
| `berth` | `id`, `(project_id, lower(name))` | ✔ |
| `vessel` | `id`, `(project_id, lower(name))` | ✔ |
| `booking` | `id` | **✗ on purpose, twice. See below** |
| `import_run`, `import_staged_*`, `import_issue` | `id` (+ `(import_id, lower(name))` for staged berth/vessel) | ✔ |

### Fixed in earlier drafts

1. **`booking.title` repeated the vessel's name** (`vessel_id → title`). Now `title` is stored only for events and
   closures; vessel bookings get the name through `booking_view`. A `CHECK` requires exactly one of `vessel_id` / `title`.
2. **Staged bookings repeated `vessel_name, vessel_length_ft` on every row.** Fixed with `import_staged_vessel`.
   `import_staged_berth` follows the same pattern.
3. **JSON blobs and stored counts.** Counts come from `COUNT(*)`; the parsed row is split into real columns.
4. **The `setting` table.** It held a single value, "today". That value belongs to a project, so it's now `project.as_of_date`.

### Deliberate violations: controlled redundancy

`booking.project_id` and `booking.berth_kind` are both determined by `berth_id`, which is not a key of `booking`.
Textbook BCNF would drop them. They're kept because each one buys something the database can't do otherwise:

| Column | What it buys |
|---|---|
| `berth_kind` | An `EXCLUDE … WHERE` can only see its own row. R2 must skip sections, so the kind has to be *on* the booking. |
| `project_id` | Lets the composite FKs guarantee that berth and vessel are in the same project as the booking. It also makes "a project's schedule" a single indexed scan. |

The usual danger of redundancy is copies that disagree. Here **the copies can't disagree**: they are part of the foreign
key, so any booking whose `(project_id, berth_id, berth_kind)` doesn't match a real berth row is rejected. That's the
point to make in review: *the redundancy is enforced, not trusted.*

### What BCNF does not cover

Normalisation is about redundancy *within* rows. The hard rules here compare **across** rows (R2, R4: date ranges of
other bookings) or **across tables** (R3, R6: vessel length vs berth length). No normal form expresses those; that's
what `EXCLUDE` and triggers are for. A perfectly normalised schema can still double-book.

### Other deliberate choices

| Thing | Why it's OK |
|---|---|
| `occupant_type` alongside `vessel_id` | Not derivable: `vessel_id IS NULL` can't tell *event* from *closure*. |
| `vessel.operator` as text | Nothing depends on operators. If contacts were in scope: `operator(id, name)` + `contact(…)`. |
| `import_issue.row_*` | An immutable snapshot of *what the file said*, mistakes included. Never updated. |
| `version`, `created_at`, `updated_at` | Bookkeeping about the row itself, determined by `id`. |

## 6. How projects and data get in

| Path | What happens |
|---|---|
| **Templates** (seeded once, `npm run db:seed`, infrastructure.md §4) | `template_key='defaults'`: 6 berths + 2 sections + 164 vessels from `backend/seed/defaults.json`, no bookings. `template_key='sample'`: the same fleet plus the sample workbook imported and committed through the normal importer, `as_of_date = 2019-07-01`. |
| **Open the sample** | `SELECT clone_project(<sample>, 'Sample — WHOI dock', 'sample')`. Every visitor gets a **private copy**, so one reviewer's edits never show up for the next. |
| **Start from the default fleet** | `clone_project(<defaults>, :name, 'defaults')` |
| **Start empty** | `INSERT INTO project (name, origin) VALUES (:name, 'empty')`. Then add berths and vessels by hand, **or** upload an `.xlsx`. |
| **Upload** (any project) | `import_run` → staged rows + issues → commit copies them into berth / vessel / booking in one transaction. Two formats: our template, or the legacy grid (backend.md §6). |
| **New bookings** | the API, every day, forward-looking |

`clone_project` is one PL/pgSQL function. It maps old ids to new ones in temp tables, copies berths, then vessels,
then bookings, all in a single statement from the app. The sample has ~2,100 bookings, so a clone takes well under a second.

Expected size: the sample template is ~2,100 bookings and ~600 vessels, under 2 MB. A clone costs the same, so
Neon's free 0.5 GB holds a few hundred live projects. Idle projects are cleaned up (infrastructure.md §5).

## 7. Queries and their cost

Sizes: ~100 bookings a year across 6 berths is ~20 per berth per year. At the 5-year horizon plus 23 years of history,
that's a few hundred per berth. Every query below is an index lookup. None scans a table.

```sql
-- conflicts for a proposed booking (the service runs this BEFORE writing, to name the blockers)
-- uses the booking_no_overlap GiST index. The ::date casts matter: untyped params make daterange() ambiguous
SELECT id, display_title, start_date, end_date FROM booking_view
WHERE berth_id = $berth AND status = 'confirmed' AND berth_kind = 'berth' AND id <> $exclude
  AND period && daterange($start::date, $end::date, '[]');

-- R4: the same query on vessel_id, served by the booking_vessel_once index

-- schedule grid for a window  → booking_window GiST index
SELECT * FROM booking_view
WHERE project_id = $p AND status = 'confirmed' AND period && daterange($from::date, $to::date, '[]')
ORDER BY berth_id, start_date;

-- availability: every active berth, its conflicts in the window, its slack for a $len-foot vessel
SELECT be.id, be.name, be.kind, be.length_ft,
       be.length_ft - $len AS slack_ft,
       COUNT(b.id) FILTER (WHERE be.kind = 'berth') AS conflicts
FROM berth be
LEFT JOIN booking b ON b.berth_id = be.id AND b.status = 'confirmed'
                   AND b.period && daterange($start::date, $end::date, '[]')
WHERE be.project_id = $p AND be.active
GROUP BY be.id
ORDER BY (COUNT(b.id) FILTER (WHERE be.kind = 'berth') = 0 AND (be.length_ft IS NULL OR be.length_ft >= $len)) DESC,
         slack_ft NULLS LAST, be.sort_order;
```

| Check | How | Cost |
|---|---|---|
| R2 overlap on a berth | GiST on `(berth_id, period)` | O(log n + k), k = actual clashes (usually 0) |
| R4 vessel in two places | GiST on `(vessel_id, period)` | O(log n + k) |
| R3 fit | two primary-key lookups | O(1) |
| R6 length edit | that vessel's / berth's confirmed bookings | O(k) |
| Delete berth/vessel | `EXISTS` on `booking_by_berth` / `booking_by_vessel` | O(log n) |
| Schedule window | GiST on `(project_id, period)` | O(log n + k) |
| Availability | one overlap probe per berth (8 berths) | O(B · log n) |
| Import | load each berth's bookings once, sort incoming rows, sweep in memory. Never one query per row | O(n log n) |
| Audit | walk each berth's bookings in start order, compare neighbours | O(n log n) |

**Why no interval tree.** On an exclusive berth, confirmed bookings never overlap, because that's R2. Sorted by start,
they're a line of disjoint intervals, so a proposed `[s, e]` can clash only with *the one booking before `s`* and with
bookings *starting inside `[s, e]`*. A B-tree already answers both. The GiST index behind `EXCLUDE` does the same job
for ranges directly, and it's the same index the constraint needs anyway.

## 8. Date gotchas (each one has bitten someone)

1. **Postgres stores `[a,b]` as `[a,b+1)`.** `daterange('2031-04-06','2031-04-06','[]')` comes back as `[2031-04-06,2031-04-07)`,
   so `upper(period)` is **the day after** the end (the schema test prints this). `start_date` / `end_date` are the truth;
   `period` is only for constraints and `&&`.
2. **node-postgres turns `date` into a JS `Date`** at local midnight, and serialising it can shift it a day. At startup:
   `pg.types.setTypeParser(1082, (v) => v)`, so `'2031-03-03'` stays a string end to end.
3. **`numeric` also comes back as a string** (`'410.0'`), to avoid float loss. Parse lengths once in the repository
   layer: `pg.types.setTypeParser(1700, parseFloat)`. That's safe here, since lengths have one decimal place.
4. **Inclusive both ends (D1).** Adjacent (`…-09` then `10-…`) is allowed; sharing a day is not. Both are in the schema test.

## 9. Migrations

Plain numbered SQL files in `db/migrations/`, applied in order by a ~30-line runner (`npm run db:migrate`). The runner
records each file name in a `schema_migration` table and wraps each file in a transaction. Migrations run from a laptop
or CI against the **unpooled** Neon URL (infrastructure.md §3), never at request time. Resetting a dev database means
deleting the Neon branch and creating it again.

## 10. Later: multi-user rejection log (not built)

v1 assumes one user (backend.md §8). If concurrent users arrive, rejected writes get logged here. The table is
append-only, and nothing references it.

```sql
CREATE TABLE write_rejection (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  at                     timestamptz NOT NULL DEFAULT now(),
  op                     text NOT NULL,     -- 'booking.create' | 'booking.update' | 'vessel.update' | …
  payload                jsonb NOT NULL,    -- what was attempted (a log record, not queried by field)
  code                   text NOT NULL,     -- OVERLAP | VESSEL_DOUBLE_BERTHED | VESSEL_TOO_LONG | STALE_VERSION | …
  conflicting_booking_id uuid,              -- no FK: the log must survive later deletes
  seen_at                timestamptz,       -- when the client loaded the data it validated against
  lost_race              boolean NOT NULL,  -- conflicting row created after seen_at
  message                text NOT NULL
);
```
