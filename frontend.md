# Frontend — build prompt

> Hand this whole file to whoever (or whatever) builds the UI. It is self-contained: design direction,
> screens, and the API. Types and request schemas are **imported** from [`shared/contract.ts`](shared/contract.ts),
> never redeclared. The endpoint table below mirrors [backend.md](backend.md) §5; if they disagree, backend.md wins.

## 0. The job

Build the web UI for a dock scheduling system at a marine research facility. One user type: the **dock coordinator**.
Everything happens inside a **project** (a workspace with its own berths, vessels and bookings). A visitor lands, opens
the sample or creates their own, and works inside `/p/[projectId]/…`.
They replace a spreadsheet grid with this app. The two things that must never slip past them are a
**double-booked berth** and a **vessel too long for its berth** — the backend refuses both; the UI's job is to
make the refusal *understandable before they press save*, and to make finding a valid slot fast.

Behavior (operations OP-01…OP-12, rules R1–R6) is defined in [manual.md](manual.md). Read it first.

## 1. Stack

- Next.js (App Router) + TypeScript (strict) + Tailwind CSS
- shadcn/ui as the component base (installed via the shadcn CLI, `npx shadcn add <name>`); plain components, themed with the palette in §2
- Motion (`motion/react`) for animation
- TanStack Query for server state (cache, refetch after mutations, request dedupe)
- `react-hook-form` + `zod` for the booking form
- `date-fns` for date math **on `ISODate` strings only** (see §6)
- No global state library. URL search params hold view state (date window, filters) so every view is linkable.

## 2. Design direction

**Mood: a harbormaster's chart table.** Calm, precise, nautical without costume. Think tide tables and
nautical charts — fine rules, tabular numbers, one confident accent — not anchors-and-rope clip art.

**Principles**

1. **The schedule is the product.** The grid gets the space; chrome stays thin.
2. **Conflict is the loudest color on screen.** Nothing else uses it. If the coordinator sees red, something needs them.
3. **Length is always visible.** Every berth label shows its length; every vessel shows its LOA. Fit is a comparison the eye should make without clicking.
4. **Say why, then say what to do.** Every "no" names the blocking booking and offers the next action (other berths, other dates).
5. **Motion explains state change** (a bar sliding to a new berth, a conflict appearing) and nothing else. Respect `prefers-reduced-motion`.

**Palette** (define as CSS variables; light and dark both required)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F6F4EF` chart paper | `#0E1620` night water | page |
| `--surface` | `#FFFFFF` | `#16212D` | cards, grid body |
| `--ink` | `#14212B` | `#E6EDF2` | text |
| `--muted` | `#5B6B78` | `#8FA1B0` | secondary text, gridlines at 12% |
| `--accent` | `#1F5F8B` harbor blue | `#5AA9E6` | primary actions, vessel bars |
| `--event` | `#B7791F` brass | `#E0A84A` | event bars |
| `--closure` | hatched `--muted` | hatched `--muted` | closures (diagonal stripes — they're "no-go water") |
| `--conflict` | `#C2410C` signal red | `#F97350` | conflicts and errors **only** |
| `--ok` | `#2F7D5B` | `#5CC596` | "fits / free" confirmations |

Check contrast: text ≥ 4.5:1; never encode meaning by color alone (bars also carry a type icon; conflicts also get an outline and an icon).

**Type:** `Inter` for UI; `JetBrains Mono` (or `tabular-nums` on Inter) for every date, length, and count, so columns line up. Lengths render as `410′` (prime, not apostrophe).

**Layout:** left rail (Schedule · Bookings · Vessels · Berths · Import · Audit), top bar with the **"today"** control (§3.9) and a global "New booking" button (`N` shortcut). Responsive down to 400px: the grid scrolls horizontally inside its own container; the page never does.

**Where to spend the polish** (all achievable with shadcn primitives + Motion; don't force any):

- The **"today" chip** in the top bar — a pill (shadcn `Popover`) that opens the date override.
- **Import summary** — a count-up reveal of bookings / vessels / issues (Motion).
- **Hover detail** on a booking bar — a shadcn `HoverCard` (vessel, LOA vs berth length, dates, notes).
- **Empty states** (no bookings in range, no issues) — a short line of copy and one next action.

Keep forms, tables, and dialogs plain shadcn — those need to be boring and dependable.

## 3. Screens

Routes: `/` landing · `/new` new project · `/p/[projectId]` schedule · `/p/[projectId]/{availability,bookings,vessels,berths,import,audit}`.
The top bar inside a project shows the project name (click → rename / copy link / switch project) and the "today" chip (3.9).

### 3.0a Landing (`/`)

The first impression, so it gets the most design care. It's static, so it renders instantly even while the DB is waking up.
- **One sentence** on what this is, over a quiet chart-table visual (a few berth rows with bars; not a stock photo).
- **Primary action: "Open the sample"** → `POST /api/projects {name:"Sample — WHOI dock", start:"sample"}` → go to
  `/p/<id>`. Show progress on the button (a clone takes ~1 s, plus up to ~1 s if the DB was asleep).
  The line under it: *"Your own copy of 23 years of the WHOI schedule. Change anything, it's yours."*
- **Secondary: "New project"** → `/new`.
- **Your projects**: ids from `localStorage["dock.projects"]` → `GET /api/projects?ids=…`. Each shows name, origin badge,
  counts and last opened. Ids the server no longer knows (cleaned up after 14 idle days) are dropped from storage without fuss.
- A 503 `UNAVAILABLE` on create → an inline message, not a toast: *"The demo is full right now — try again tomorrow."*

### 3.0b New project (`/new`)

One page, three steps, all visible at once (not a multi-page wizard):
1. **Name** (required, ≤ 80 characters), and **Planning from**: a date defaulting to the real today. It becomes the
   project's "today" (`ProjectInput.asOfDate`), the earliest date you're planning for. E.g. `2008-04-27` to plan
   the 2008 season with the old workbook.
2. **Starting point**, as three large radio cards:
   - **Default fleet**: "6 berths, 2 shared sections, 164 vessels from the WHOI workbook. No bookings." → `start:"defaults"`.
   - **Empty**: "Add berths and vessels yourself." → `start:"empty"`.
   - **Upload a spreadsheet**: "Your own fleet and bookings." → `start:"empty"`, then upload. The card expands to show:
     a **Download the template** link (`/dock-template.xlsx`), a one-line description of its three sheets
     (Berths · Vessels · Bookings), a dropzone, the note *"The original year-per-sheet workbook works too."*, and
     **Planning until** (default: from + 5 years). Only bookings touching *from → until* are brought in.
3. **Create** → `POST /api/projects`. With a file: then `POST /api/projects/<id>/imports` and go straight to that import's
   preview (3.7 step 2). Otherwise go to `/p/<id>`.
   Remember the id in `localStorage` as soon as the project exists, before the upload, so a failed upload doesn't lose it.


### 3.1 Calendar (`/p/[projectId]`, OP-01): the home screen, every view

One screen, two independent controls. **Lens** is *whose* calendar; **scale** is *how much time*. Every combination is
valid. All state lives in the URL, so every view is linkable:
`/p/<pid>?lens=berths|berth|vessels|vessel&id=<berthId|vesselId>&scale=day|week|month|quarter|year&date=YYYY-MM-DD`
(`date` = the anchor; the window is computed from it. Weeks start Monday. Defaults: `lens=berths`, `scale=month`, `date=today`.)

| Lens → / Scale ↓ | **All berths** (the whole port) | **One berth** | **All vessels** | **One vessel** |
|---|---|---|---|---|
| **Day** | *Dock board*: a card per berth with who's there, "arriving today", "departing today", or **Free** (with length) | Agenda: today's occupant, plus the previous and next bookings with gaps ("free for 12 days") | *In port today*: vessels at the dock, their berth and days left | Where it is today; where it was last and goes next |
| **Week** | Timeline: berths × 7 day columns, bars with names and LOA | 7-day strip, bars full height | Timeline: vessels × 7 days, bars labelled by **berth** | 7-day strip |
| **Month** | Timeline: berths × ~31 days (the classic grid) | **Month calendar** (7 × 6 cells), bars spanning cells | Timeline: vessels × ~31 days | Month calendar, cells coloured by berth |
| **Quarter** | Timeline, narrow day columns, names shown when they fit | 3 month calendars | Timeline | 3 month calendars |
| **Year** | **Heatmap**: berths × 365 days, occupied/free, month ticks. Click a month to go to month scale | 12 mini month calendars + "occupied N of 365 days" | Vessels ranked by days in port, with a sparkline per vessel | 12 mini months + days in port, by berth |

Across every view:
- **Header row** (all lenses, week and up): a thin *occupancy strip*, the % of exclusive berths taken each day. Its peak
  and trough are what a coordinator scans for.
- **Timelines** have a sticky left column (berth: `North Pier West · 410′`, sections marked *shared*; vessel:
  `R/V High Drift · 120′`) and a sticky day header with weekday letters and a **today line**. Weekends are shaded.
- **Bars:** vessels show name + LOA; events use the event colour; closures are hatched. A bar cut off by the window shows
  a fade and an arrow on the cut edge. Section rows stack overlapping bars into lanes (greedy, by start date).
- **Vessel lenses** show only vessel bookings. A toggle "Also show events & closures" adds them as a group of rows at the bottom.
- **Filters** (a popover, reflected in the URL): occupant types (vessel / event / closure), include sections, berth subset.
- **Navigation:** prev / next (one scale step), **Today** (to the project's "today"), a date picker, and keyboard `←/→`,
  `t`, `d/w/m/q/y` for scale. Switching lens keeps scale and date.
- **Interaction:** click a bar → booking drawer (edit / cancel). Drag across empty days in a berth row → New booking
  prefilled with that berth and range. Click a vessel's name → its One-vessel lens.
- **Data:** one `GET …/schedule?from&to` per window (every scale fits within `MAX_WINDOW_DAYS`), pivoted client-side by
  lens. One vessel beyond the window ("last seen", "next visit") uses `GET …/bookings?vesselId=…&from&to` over ±1 year.

Build the timeline once (rows × days, with row and bar renderers passed in) and the month calendar once. Every cell of
the table above is one of those two components, a card list (day), or the heatmap (year).

### 3.2 New / edit booking (dialog or drawer; OP-04, OP-05)

Fields: type (segmented: Vessel · Event · Closure) → vessel combobox (search `GET …/vessels?q=`, shows LOA; "Register new vessel" inline) **or** title → berth select (shows length) → start / end (range picker) → notes.

**Live validation — the core interaction:**
- On any change (debounce 250 ms, only when all required fields are present) call `POST …/bookings/validate` (pass `excludeBookingId` when editing). Cancel the previous request when a new one starts.
- Show a status panel under the form:
  - ✅ `Fits with 30′ to spare · berth free` (green; slack = berth length − vessel LOA, both already on screen) — Save enabled.
  - ⚠ `IN_PAST` warning — Save enabled, message shown.
  - ⛔ each error violation, with its `message`. For `OVERLAP` / `VESSEL_DOUBLE_BERTHED`, list the blocking bookings (link to them) using `bookingIds`. For `VESSEL_TOO_LONG` show a small **fit bar**: vessel length drawn against berth length, overflow in `--conflict`, "short by 12′".
  - When blocked: a **"Find another berth"** button that opens Availability (3.3) prefilled with the dates and vessel.
- Save → `POST …/bookings` (or `PATCH` with `expectedVersion`). If the server still returns 409/422 (someone booked in between), show the returned violations in the same panel. `STALE_VERSION` → "This booking changed since you opened it" + Reload.
- Vessel with unknown length → inline "Add length" field that `PATCH`es the vessel, then re-validates.

### 3.3 Availability (`/availability`, OP-03)

Inputs: date range + vessel (or raw length in feet). Results from `GET …/availability` as a list/cards:
free-and-fits first, each with slack (`+15′ spare`), a green "Book" button that opens 3.2 prefilled.
Berths that don't work stay visible, dimmed, with the reason ("Too short by 20′", "Held by R/V Golden Compass 3–6 Mar").
Also reachable from the form's "Find another berth".

### 3.4 Bookings list (`/bookings`, OP-02)

Filterable table: date range (required), berth, type, text search, include cancelled. Columns: dates, berth, occupant (with LOA / berth length), type, status, source (manual / import). Row click → detail drawer. Cancel from the drawer (`POST …/bookings/:id/cancel` with confirm dialog).

### 3.5 Vessels (`/vessels`, OP-07)

Table + search; **New vessel** and a delete action per row (confirm dialog; a 409 shows "Used by 12 bookings — can't delete"); filter **"Length unknown"** (legacy vessels — there will be hundreds; make it easy to fill them in one after another with an inline length field). Create/edit form. A 409 on length edit lists the bookings the new length would break.

### 3.6 Berths (`/berths`, OP-08)

Short list (8 rows by default): name, kind, length, active toggle, utilization over the current window. **New berth** (name, kind, length — length hidden and null for a section).
Edit length/name/order; 409 lists affected bookings. Delete per row with confirm; on 409 ("has bookings") offer **Deactivate instead** in the same dialog.

### 3.7 Import (`/import`, OP-09, OP-10)

1. **Upload** — dropzone for `.xlsx` (refuse > 4 MB before sending) → `POST …/imports` (multipart). Show parsing progress
   (indeterminate; the request takes a few seconds). Beside it: **Download the template** (`/dock-template.xlsx`). The server
   detects the format (template or legacy grid); show `ImportRun.format` as a badge in the preview.
   Above the dropzone: **Planning window**, *from* = the project's today (read-only here, with a link to change it)
   and *until* (field `planTo`, default from + 5 years). The preview states it plainly: *"1,812 bookings outside
   27 Apr 2008 – 15 Jan 2009 were skipped"* (`counts.outsideWindow`).
2. **Preview** — the `ImportRun` summary: berths, vessels and bookings to add, issues by severity (error / warning / info). Actions: **Commit** (`POST /commit`, confirm dialog stating the count) and **Discard** (`DELETE`).
3. **Issues** — tabs by severity, filter by code, cursor-paginated (`GET /issues`). Each issue: code badge, sheet + cell (`2010 · AF44`), message, and the parsed row (occupant, dates, raw berth label).
   Actions on rows that have a `row`: **Create booking** (choose berth — show the availability list inline: `GET …/availability?startDate&endDate&lengthFt=row.vesselLengthFt`; if `vesselLengthFt` is null, ask for it first and send it as `ResolveIssueInput.vesselLengthFt`) or **Dismiss** (optional reason). Resolved issues fade and move to a "Resolved" tab.
   `MODEL_CLASSIFIED` rows get a small "classified by model" badge, so the user can double-check them.
   Info-level issues are collapsed by default ("3 December carry-overs dropped, 104 notes skipped…").
4. Past imports list (`GET …/imports`).

Copy for the empty import page should say plainly: *upload our template to set up berths, vessels and bookings, or the original workbook to bring in its history. New bookings are the future.*

### 3.9 Conflicts (`/conflicts`)

A rail item under Import, with a red count of open conflicts. Rows from committed imports that read fine but couldn't be
placed as written (`GET …/conflicts`, `GET …/conflicts/summary`).
- **Totals** by status (open / placed / dismissed), each a filter.
- **Type chips** with open counts: Berth taken (`OVERLAP`), Too long, Vessel elsewhere, No berth, Berth off. Plus a
  berth filter and a search box. Filters live in the URL.
- **Card per conflict**, earliest first: type, occupant, dates, the berth it asked for (and lengths, "short by 12′"),
  the message, and the bookings **in the way now** (click → booking detail). "Nothing is in the way any more" when
  the blockers are gone.
- **Place…** → editable dates, a length prompt if the vessel has none, and the availability list for those days
  (the requested berth marked). Picking a berth sends `place`. **Dismiss** takes an optional reason.
- **Bulk**: with a type chip selected, "Dismiss all N …" (confirm dialog).
- **Auto-resolve** is shown disabled: the CP-SAT solver (backend.md §6.6) comes later.

The import preview shows the conflict count by type and says they move to the Conflicts tab on commit.

### 3.8 Audit (`/audit`, OP-11)

One button, "Run audit" → `GET …/audit`. Healthy result is the hero: a big calm ✓ "N bookings checked · 0 violations" (N = `checkedBookings`). Any violations → a table grouped by code with links.

### 3.9 "Today" control (top bar, OP-12)

Chip showing the current as-of date and whether it's real or overridden (`Today · 21 Sep 2026` vs `Viewing as of 1 Jan 2020 ·  reset`). Click to pick a date → `PUT …/settings`; "Use real date" → `PUT { asOfDate: null }`. On change, invalidate schedule queries and move the grid window to the new today.

## 4. States every screen needs

Loading (skeletons shaped like the content — grid skeleton for Schedule), empty (with a next action), error (the `ApiError.message` + retry), and optimistic updates **only** for cancel (revert on failure). Never optimistic-create a booking — the server is the judge of conflicts.

## 5. Accessibility

Keyboard: grid cells are navigable with arrow keys, `Enter` opens the booking/new-booking; dialogs trap focus; `Esc` closes.
Bars have accessible names: "R/V Golden Compass, 124 feet, North Pier West, 3 to 6 March 2026". Violations are announced via an `aria-live="polite"` region in the form.

## 6. Dates — read this

Every booking date is an `ISODate` string (`"2026-03-05"`), a **calendar day with no time and no zone**. Both ends inclusive: `5–9` occupies five cells.

- Never `new Date("2026-03-05")` — it parses as UTC midnight and renders as the 4th west of Greenwich.
- Parse with `date-fns/parseISO` then use local-date functions, or keep the string and compare lexicographically (it sorts correctly).
- Number of days = `differenceInCalendarDays(end, start) + 1`.
- Send dates back exactly as `YYYY-MM-DD`.

## 7. API contract

Same Next.js app, same origin: base URL is `/api`; everything except `/api/projects` and `/api/health` lives under `/api/projects/:pid`. JSON everywhere except the import upload (multipart, field name `file`).

### 7.1 Shared types — import from `shared/contract.ts`

Path alias `@shared/*` → `shared/*` in `tsconfig.json`. Use the types for API data, and the zod schemas
(`BookingInputSchema`, `VesselInputSchema`, …) as the `react-hook-form` resolver. That way the form rejects exactly what the
server rejects for shape; rule violations still come from `POST …/bookings/validate`.

Constants the UI needs: `DATE_MIN`/`DATE_MAX` (date-picker bounds), `HARD_HORIZON_YEARS` (disable days after `asOfDate + 5y` in the booking picker; `FAR_FUTURE` arrives from validate as a normal warning),
`MAX_WINDOW_DAYS` (largest schedule window: Quarter view is well inside it).

### 7.2 Endpoints (mirrors backend.md §5)

**Projects**

| Method | Path | Body / query | Success | Notes |
|---|---|---|---|---|
| GET | `/api/health` | – | `{ ok: true }` | also pings the DB |
| GET | `/api/projects` | `?ids=a,b,c` (≤ `MAX_PROJECTS_PER_REQUEST`) | `Project[]` | only the ids asked for; unknown ids are left out. **Never lists all projects** |
| POST | `/api/projects` | `ProjectInput` | `Project` (201) | `sample` / `defaults` → `clone_project(template)`; `empty` → blank. 503 `UNAVAILABLE` at the cap |
| GET | `/api/projects/:pid` | – | `Project` | bumps `lastOpenedAt` (the cleanup clock) |
| PATCH | `/api/projects/:pid` | `ProjectPatch` | `Project` | rename |
| DELETE | `/api/projects/:pid` | – | 204 | deletes everything in it |

**Inside a project.** Every path below is prefixed with `/api/projects/:pid`.

| Method | Path | Body / query | Success | Notes |
|---|---|---|---|---|
| GET | `/settings` | – | `Settings` | |
| PUT | `/settings` | `SettingsPatch` | `Settings` | set or clear the "today" override |
| GET | `/berths` | `?includeInactive=true` | `Berth[]` | ordered by `sortOrder` |
| POST | `/berths` | `BerthInput` | `Berth` (201) | 409 on duplicate name |
| PATCH | `/berths/:id` | `BerthPatch` | `Berth` | 409 if the change would invalidate existing bookings |
| DELETE | `/berths/:id` | – | 204 | 409 if any booking references it → deactivate instead |
| GET | `/vessels` | `?q=&lengthUnknown=true` | `Vessel[]` | `q` = case-insensitive substring |
| POST | `/vessels` | `VesselInput` | `Vessel` (201) | name unique per project (case-insensitive) |
| PATCH | `/vessels/:id` | `Partial<VesselInput>` | `Vessel` | 409 if a new length breaks a booking |
| DELETE | `/vessels/:id` | – | 204 | 409 if any booking references it |
| GET | `/schedule` | `?from=&to=` (`ISODate`) | `ScheduleResponse` | one call for the grid; window ≤ `MAX_WINDOW_DAYS` |
| GET | `/bookings` | `?from=&to=&berthId=&vesselId=&occupantType=&q=&includeCancelled=` | `BookingView[]` | `from`/`to` required; window ≤ `MAX_WINDOW_DAYS` |
| POST | `/bookings` | `BookingInput` | `BookingView` (201) | 409 `OVERLAP` / `VESSEL_DOUBLE_BERTHED`; 422 others |
| GET | `/bookings/:id` | – | `BookingView` | |
| PATCH | `/bookings/:id` | `BookingPatch` | `BookingView` | 409 `STALE_VERSION` if `expectedVersion` is old |
| POST | `/bookings/:id/cancel` | `{ expectedVersion }` | `BookingView` | soft delete; frees the berth |
| POST | `/bookings/validate` | `ValidateRequest` | `ValidationResult` | dry run; never writes; 200 even when violations exist (404 only for unknown ids) |
| GET | `/availability` | `?startDate=&endDate=&vesselId=` or `&lengthFt=` | `AvailabilityResult` | |
| POST | `/imports` | multipart `file` (.xlsx, ≤ 4 MB) + optional `planTo` | `ImportRun` (201) | window = project today → `planTo`; parses, stages; writes **nothing** live |
| GET | `/imports` | – | `ImportRun[]` | newest first |
| GET | `/imports/:id` | – | `ImportRun` | |
| GET | `/imports/:id/issues` | `?severity=&code=&resolved=&cursor=&limit=` | `Page<ImportIssue>` | |
| POST | `/imports/:id/commit` | – | `ImportRun` | one transaction; only once per import |
| DELETE | `/imports/:id` | – | 204 | discards a `previewed` import |
| POST | `/imports/:id/issues/:issueId/resolve` | `ResolveIssueInput` | `ImportIssue` | `create_booking` goes through the normal rules |
| GET | `/conflicts` | `?type&status&berthId&q&cursor&limit` | `Page<Conflict>` | open by default, earliest first, live `blockers` |
| GET | `/conflicts/summary` | – | `ConflictSummary` | counts by status, open by type and by berth |
| POST | `/conflicts/:id/resolve` | `ResolveConflictInput` | `Conflict` | `place` goes through the normal rules; `dismiss` |
| POST | `/conflicts/dismiss` | `DismissConflictsInput` | `{ dismissed }` | bulk: given ids, or every open one of a type |
| POST | `/conflicts/solve` | `SolveRequest` | `SolveResult` | CP-SAT proposals for the selected conflicts; writes nothing |
| POST | `/conflicts/apply` | `ApplyProposalsInput` | `ApplyProposalsResult` | one booking per segment, normal rules, one transaction; 409 if stale |
| GET | `/audit` | – | `AuditReport` | re-verifies every rule over all bookings |

### 7.3 Error handling

Every non-2xx body is `ApiError`. Map it like this:

| Status | `error.code` | UI |
|---|---|---|
| 400 | `VALIDATION` | a bug in the client — show message, log it |
| 404 | `NOT_FOUND` | "This booking no longer exists" + back |
| 409 | `CONFLICT` | show `violations` in the form's status panel (never a toast) |
| 409 | `STALE_VERSION` | "Changed since you opened it" + Reload |
| 422 | `UNPROCESSABLE` | show `violations` in the status panel |
| 403 | `FORBIDDEN` | shouldn't happen (templates are never opened directly): show message |
| 503 | `UNAVAILABLE` | inline "demo is full" (3.0a) |
| 500 | `INTERNAL` | toast + retry |

### 7.4 Client boilerplate

```ts
// src/lib/api/client.ts
import type { ApiError } from "@shared/contract";

const BASE = "/api";

export class ApiRequestError extends Error {
  constructor(public status: number, public body: ApiError) { super(body.error.message); }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, headers, ...rest } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json();
  if (!res.ok) throw new ApiRequestError(res.status, body as ApiError);
  return body as T;
}

export const qs = (p: Record<string, string | number | boolean | undefined | null>) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)])).toString();
```

```ts
// src/lib/api/endpoints.ts — one function per endpoint; components never call fetch directly
import type * as T from "@shared/contract";
import { api, qs } from "./client";

export const listProjects  = (ids: T.Id[]) => api<T.Project[]>(`/projects?${qs({ ids: ids.join(",") })}`);
export const createProject = (body: T.ProjectInput) => api<T.Project>("/projects", { method: "POST", json: body });
export const getProject    = (pid: T.Id) => api<T.Project>(`/projects/${pid}`);

// everything else is scoped: const p = inProject(pid); p.getSchedule(from, to)
export const inProject = (pid: T.Id) => {
  const P = `/projects/${pid}`;
  return {
    getSchedule:   (from: T.ISODate, to: T.ISODate) => api<T.ScheduleResponse>(`${P}/schedule?${qs({ from, to })}`),
    validate:      (body: T.ValidateRequest) => api<T.ValidationResult>(`${P}/bookings/validate`, { method: "POST", json: body }),
    createBooking: (body: T.BookingInput) => api<T.BookingView>(`${P}/bookings`, { method: "POST", json: body }),
    updateBooking: (id: T.Id, body: T.BookingPatch) => api<T.BookingView>(`${P}/bookings/${id}`, { method: "PATCH", json: body }),
    cancelBooking: (id: T.Id, expectedVersion: number) => api<T.BookingView>(`${P}/bookings/${id}/cancel`, { method: "POST", json: { expectedVersion } }),
    availability:  (q: { startDate: T.ISODate; endDate: T.ISODate; vesselId?: T.Id; lengthFt?: number }) =>
      api<T.AvailabilityResult>(`${P}/availability?${qs(q)}`),
    uploadImport:  (file: File) => { const f = new FormData(); f.append("file", file); return api<T.ImportRun>(`${P}/imports`, { method: "POST", body: f }); },
    getSettings:   () => api<T.Settings>(`${P}/settings`),
    putSettings:   (body: T.SettingsPatch) => api<T.Settings>(`${P}/settings`, { method: "PUT", json: body }),
    // …the rest follow the same shape: one per row of §7.2.
  };
};
```

```ts
// query keys — invalidate [pid, "schedule"] and [pid, "bookings"] after any booking mutation, commit, or resolve
// every key starts with the project id, so switching projects can never show another project's cached data
export const qk = {
  projects: (ids: string[]) => ["projects", ids] as const,
  project: (pid: string) => ["project", pid] as const,
  schedule: (pid: string, from: string, to: string) => [pid, "schedule", from, to] as const,
  bookings: (pid: string, f: object) => [pid, "bookings", f] as const,
  availability: (pid: string, q: object) => [pid, "availability", q] as const,
  vessels: (pid: string, q?: string) => [pid, "vessels", q] as const,
  berths: (pid: string) => [pid, "berths"] as const,
  settings: (pid: string) => [pid, "settings"] as const,
  imports: (pid: string) => [pid, "imports"] as const,
  issues: (pid: string, id: string, f: object) => [pid, "imports", id, "issues", f] as const,
};
```

## 8. Acceptance checklist

- [ ] Every row of manual.md's worked-examples table can be reproduced in the UI and shows the right message *before* Save.
- [ ] A too-long vessel shows the fit bar with the exact shortfall.
- [ ] "Find another berth" lands on availability with the tightest free fit first.
- [ ] Importing the sample workbook shows the summary, and every error-level issue can be created or dismissed.
- [ ] Setting "today" to 2020-01-01 moves the grid and the today line; bookings before it show the `IN_PAST` warning when edited.
- [ ] Light and dark themes; 400px width; keyboard-only booking flow works; reduced motion respected.
- [ ] No `new Date(isoDateString)` anywhere (grep for it).
