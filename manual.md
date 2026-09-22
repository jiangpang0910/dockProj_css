# Operations Manual

What a dock coordinator can do, and the rules the system holds them to. This is the contract the
API ([backend.md](backend.md)) and UI ([frontend.md](frontend.md)) both implement. If an operation isn't
here, it isn't in scope.

## Vocabulary

| Term | Meaning |
|---|---|
| **Workspace** | The one shared schedule: its berths, vessels, bookings, tours and "today". Everything below happens inside it. |
| **Berth** | A named mooring with a fixed length in feet (e.g. North Pier West, 410′). Holds one occupant per day. |
| **Section** | A shared area with no defined length (small-craft slips, finger piers). Many boats at once. |
| **Vessel** | A boat with a name and a length overall (LOA). |
| **Booking** | A berth held for an inclusive range of days by a vessel, an event, or a closure. |
| **Event** | A non-vessel use that takes a berth (community sail day, campus event). |
| **Closure** | A berth made unusable (maintenance, repair, crane access). |
| **Conflict** | A workbook row the seed could not turn into a valid booking, kept for someone to place or dismiss. |

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

Also: a vessel with no recorded length can't be booked by hand (`VESSEL_LENGTH_UNKNOWN`); rows loaded by the seed are exempt.

**Warnings, not rules.** A booking whose whole range is before "today" returns `IN_PAST` (D10, see OP-12). A manual
booking ending more than 2 years after "today" returns `FAR_FUTURE` ("typo?"). Warnings never block a save.
**Horizon (D12).** A manual booking ending more than 5 years after "today" is refused: `BEYOND_HORIZON`. The seed is exempt.

**Date semantics (D1).** Dates are calendar days, no times, no time zones. Both ends are inclusive:
a booking 5–9 March occupies the 5th, 6th, 7th, 8th and 9th. A vessel departing on the 9th
therefore blocks another arriving on the 9th. Two ranges overlap exactly when neither ends before the other starts.

**Cancelled bookings** occupy nothing and are ignored by R2–R4. They are kept for history.

## Operations

Each operation lists: what you give it → what comes back → how it can fail.
Paths from OP-01 on are relative to `/api/projects/:pid`.

### The workspace

**OP-00 Open the workspace.** There is one: the WHOI dock, loaded from the workbook when the database is seeded and
viewed as of 1 Jul 2019. Signing in and going to `/` opens it. Everyone works in the same schedule — what you book,
the next person sees. It can be renamed, and its link can be copied, but it cannot be deleted or duplicated from the
app; re-seeding the database (`npm run db:seed -- --force`) is what resets it.
→ `GET /api/projects`, `GET/PATCH /api/projects/:pid`.

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

### Checking

**OP-11 Audit.** Re-check every rule against every confirmed booking and report violations.
On a healthy database this is empty — it is the proof, and the safety net if data was edited outside the app. → `GET /audit`.

### Settings

**OP-12 Set "today".** Each project has a configurable "today" (the sample's history ends in 2019, so the sample opens
as of 1 Jul 2019). By default it is the real date; you can override it (e.g. `2020-01-01`) or clear the override. It sets the default schedule window,
the today marker, and which bookings get the `IN_PAST` warning. It never changes what is valid. → `GET/PUT /settings`.

## What the seed reports

Loading the workbook is not lossless, and the parts it can't turn into a valid booking are kept, not silently dropped.
Four of them become **conflicts** you work through on the Conflicts screen:

| Code | Meaning |
|---|---|
| `NO_BERTH` | The row sits on an unlabeled overflow line, so its berth is unknown |
| `OVERLAP` | It overlaps a booking already accepted (the earlier-starting one wins) |
| `VESSEL_TOO_LONG` | The vessel is longer than that berth |
| `VESSEL_DOUBLE_BERTHED` | The same vessel is already booked elsewhere on those days |

The rest are reported by the parser and recorded against the run — carry-over months dropped, year labels corrected
from the weekday letters, operational notes ("ETA 1200", "Fuel truck") recognised as not-bookings. They need no
decision from anyone, and the seed prints their counts.

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
