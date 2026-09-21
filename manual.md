# Operations Manual

What a dock coordinator can do, and the rules the system holds them to. This is the contract the
API ([backend.md](backend.md)) and UI ([frontend.md](frontend.md)) both implement. If an operation isn't
here, it isn't in scope.

## Vocabulary

| Term | Meaning |
|---|---|
| **Project** | A workspace: its own berths, vessels, bookings, imports and "today". Everything below happens inside one project. |
| **Berth** | A named mooring with a fixed length in feet (e.g. North Pier West, 410′). Holds one occupant per day. |
| **Section** | A shared area with no defined length (small-craft slips, finger piers). Many boats at once. |
| **Vessel** | A boat with a name and a length overall (LOA). |
| **Booking** | A berth held for an inclusive range of days by a vessel, an event, or a closure. |
| **Event** | A non-vessel use that takes a berth (community sail day, campus event). |
| **Closure** | A berth made unusable (maintenance, repair, crane access). |
| **Import issue** | A legacy spreadsheet row that could not be turned into a valid booking automatically. |

## Rules (invariants)

The system must make it impossible to save a booking that breaks **R1–R5**. R6 governs edits to reference data.

| | Rule | Applies to | Violation code |
|---|---|---|---|
| **R1** | `endDate` ≥ `startDate`, both real calendar dates | all | `INVALID_RANGE` |
| **R2** | No two *confirmed* bookings on the same berth share a day | berths (not sections) | `OVERLAP` |
| **R3** | Vessel length ≤ berth length | vessel bookings on berths | `VESSEL_TOO_LONG` |
| **R4** | A vessel is in one berth at a time (no overlapping confirmed bookings for the same vessel) | vessel bookings | `VESSEL_DOUBLE_BERTHED` |
| **R5** | A berth marked inactive takes no new bookings | all | `BERTH_INACTIVE` |
| **R6** | Changing a berth's or vessel's length may not break an existing confirmed booking | reference-data edits | `VESSEL_TOO_LONG` / 409 |

Also: a vessel with no recorded length can't be booked by hand (`VESSEL_LENGTH_UNKNOWN`); legacy imports are exempt.

**Warnings, not rules.** A booking whose whole range is before "today" returns `IN_PAST` (D10, see OP-12). A manual
booking ending more than 2 years after "today" returns `FAR_FUTURE` ("typo?"). Warnings never block a save.
**Horizon (D12).** A manual booking ending more than 5 years after "today" is refused: `BEYOND_HORIZON`. Imports are exempt.

**Date semantics (D1).** Dates are calendar days, no times, no time zones. Both ends are inclusive:
a booking 5–9 March occupies the 5th, 6th, 7th, 8th and 9th. A vessel departing on the 9th
therefore blocks another arriving on the 9th. Two ranges overlap exactly when neither ends before the other starts.

**Cancelled bookings** occupy nothing and are ignored by R2–R4. They are kept for history.

## Operations

Each operation lists: what you give it → what comes back → how it can fail.
Paths from OP-01 on are relative to `/api/projects/:pid`.

### Projects

**OP-00 Open or create a project.** The landing page offers:
- **Open the sample.** You get your *own copy* of the sample: the default fleet plus 23 years of imported history, viewed
  as of 1 Jul 2019. Nothing you do affects anyone else's copy.
- **New project**, starting from the **default fleet** (6 berths, 2 sections, 164 vessels, no bookings), **empty**, or
  **empty + upload a spreadsheet** (our template, or the original workbook; see OP-09).
- **Your projects**, the ones this browser has opened.

There is no login: a project's link is its key. Projects left unopened for 14 days are deleted.
→ `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:pid`.

### Looking

**OP-01 View schedule.** Choose a date range (day / week / month / quarter). See a grid: berths as rows
(with their lengths), days as columns, bookings as bars. Closures and events look different from vessels.
Today is marked. → `GET /schedule`.

**OP-02 Find bookings.** Filter by date range, berth, type, or text (vessel/event name); optionally include cancelled. → `GET /bookings`.

**OP-03 Check availability.** Give a date range and either a vessel or a raw length. Get every berth
with: free or not, fits or not, and slack in feet. Free-and-fits berths come first, tightest fit first
(so a 40′ boat isn't offered the 410′ berth ahead of a 55′ one). Non-matching berths stay listed with the reason. → `GET /availability`.

### Booking

**OP-04 Create booking.** Choose type (vessel / event / closure), berth, start, end.
Vessels: pick a registered vessel. Events/closures: give a title. The UI checks as you type
(dry run) and shows conflicts *before* you save. Fails with any of R1–R5, naming the bookings in the way. → `POST /bookings/validate`, `POST /bookings`.

**OP-05 Edit booking.** Change dates, berth (move), or notes. Same rules as create, ignoring the booking itself.
If someone else changed it first, you get `STALE_VERSION` and must reload. → `PATCH /bookings/:id`.

**OP-06 Cancel booking.** Marks it cancelled; the berth is free again for those days. Not a hard delete. → `POST /bookings/:id/cancel`.

*(Block a berth for maintenance = OP-04 with type "closure".)*

### Reference data

**OP-07 Create / edit / delete vessel.** Name (unique, ignoring case and spacing) and length are required. Optional: draft, operator, notes.
Editing the length is subject to R6. A vessel can be deleted only if no booking (of any status) refers to it; otherwise the system refuses and says how many bookings do.
→ `POST/PATCH/DELETE /vessels`. Filter "length unknown" to find legacy vessels that need a length.

**OP-08 Create / edit / delete berth.** Create with a name and either a length (berth) or no length (shared section). Rename, change length, reorder, or deactivate.
Length change is subject to R6; deactivating doesn't touch existing bookings, it only stops new ones. A berth can be deleted only if no booking refers to it;
otherwise deactivate it. → `POST/PATCH/DELETE /berths`.

**Defaults.** The *default fleet* is the berths and vessels found in the sample workbook (6 berths, 2 sections, 164 vessels
with lengths; see backend.md §9). A project started from it gets its own copy: everything in OP-07/OP-08 applies, and
nothing you change touches another project.

### Spreadsheet upload

**OP-09 Import a spreadsheet.** Upload an `.xlsx` in either format; the system tells them apart by sheet names:
- **Our template** (`dock-template.xlsx`, downloadable from the import page): sheets *Berths*, *Vessels*, *Bookings*,
  one record per row. Any sheet may be left out. This is how you set up your own fleet.
- **The original workbook**: one sheet per year, the grid layout. Berth labels like `North Pier West - 410'` create
  the berth if the project doesn't have it.

The system parses the file, **stages** the result, and shows a summary: berths, vessels and bookings found, and issues by severity. Nothing is written to the live schedule until you
**commit**; you can discard the preview. Commit inserts every row that satisfies R1–R5 and leaves the rest as issues. → `POST /imports`, `POST /imports/:id/commit`, `DELETE /imports/:id`.

**OP-10 Triage import issues.** For each issue that has a usable row:
- *Create booking* — you choose the berth (with the availability list to help); it goes through the normal rules. Or
- *Dismiss* — with an optional reason (e.g. "historical, not actionable").

Info-level issues (auto-fixed year labels, skipped notes) need no action. → `GET /imports/:id/issues`, `POST .../resolve`.

**OP-11 Audit.** Re-check every rule against every confirmed booking and report violations.
On a healthy database this is empty — it is the proof, and the safety net if data was edited outside the app. → `GET /audit`.

### Settings

**OP-12 Set "today".** Each project has a configurable "today" (the sample's history ends in 2019, so the sample opens
as of 1 Jul 2019). By default it is the real date; you can override it (e.g. `2020-01-01`) or clear the override. It sets the default schedule window,
the today marker, and which bookings get the `IN_PAST` warning. It never changes what is valid. → `GET/PUT /settings`.

## Import issue types

| Code | Meaning | Needs action? |
|---|---|---|
| `NO_BERTH` | Row sits on an unlabeled overflow line; berth unknown | Yes — choose a berth, or dismiss |
| `OVERLAP` | Overlaps a booking that was already accepted (the earlier-starting one wins) | Yes |
| `VESSEL_TOO_LONG` | Vessel is longer than that berth | Yes |
| `VESSEL_DOUBLE_BERTHED` | Same vessel already booked elsewhere those days | Yes |
| `OUTSIDE_MONTH_COLUMNS` | Cell sits before day 1 of its month block (carry-over from previous month) | Review |
| `UNPARSEABLE_CELL` | Couldn't place the cell | Review |
| `HEADER_YEAR_MISMATCH` | Month header year contradicted the weekday letters; year inferred | No (info) |
| `DUPLICATE_CARRYOVER` | December repeated at the top of the next year's sheet; duplicate dropped | No (info) |
| `DUPLICATE_EXISTING` | Already in the project: an identical booking, or a berth/vessel of the same name (re-importing is safe); skipped | No (info) |
| `ANNOTATION_SKIPPED` | Operational note ("ETA 1200", "Fuel truck") is not a booking | No (info) |
| `UNKNOWN_FORMAT` | Neither our template nor the year-per-sheet grid; nothing imported | Yes: use the template |
| `TEMPLATE_BAD_HEADER` | A template sheet's header row doesn't match; that sheet skipped | Yes: fix the header, re-upload |
| `INVALID_VALUE` | A template cell is wrong (kind, length, type, date); row skipped | Yes: fix, re-upload |
| `DUPLICATE_NAME` | Same berth/vessel name twice in the file; first kept | Review |

## Worked examples (each should become a test)

| Existing on berth B (day range) | Request on B | Result |
|---|---|---|
| Vessel A, 5–9 | Vessel C, 10–12 | OK (adjacent, no shared day) |
| Vessel A, 5–9 | Vessel C, 9–12 | **OVERLAP** (share the 9th) |
| Vessel A, 5–9 | Vessel C, 6–7 | **OVERLAP** (contained) |
| Vessel A, 5–9 | Vessel C, 5–9 | **OVERLAP** (identical) |
| Vessel A, 5–9 (cancelled) | Vessel C, 5–9 | OK |
| — (berth 55′) | 60′ vessel | **VESSEL_TOO_LONG**, short by 5′ |
| — (berth 60′) | 60′ vessel | OK (equal length fits) |
| Vessel A on berth B1, 5–9 | Vessel A on berth B2, 8–10 | **VESSEL_DOUBLE_BERTHED** |
| Section "Small craft slips": boats X and Y both 5–9 | – | OK (sections are shared) |
| — | Booking 9–5 | **INVALID_RANGE** |
| — | Vessel with unknown length, by hand | **VESSEL_LENGTH_UNKNOWN** |
| — ("today" = 2026-09-21) | Booking 2019-03-01 to 2019-03-05 | Saved, with `IN_PAST` warning |
:
