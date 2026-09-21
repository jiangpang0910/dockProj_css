/**
 * The API contract — the ONE source of truth for types shared by the route handlers and the UI.
 * Docs (backend.md, frontend.md) describe it; they do not copy it. Change it here, and only here.
 *
 * Part 1: TypeScript types (what goes over the wire).
 * Part 2: zod schemas for every request body / query (used by the route handlers to validate,
 *         and by react-hook-form on the client — so the form and the server reject the same things).
 *
 * Dates are "YYYY-MM-DD" strings, compared lexicographically. Never `new Date(isoDate)`.
 */
import { z } from "zod";

// ═════════════════════════════ Part 1: types ═════════════════════════════

// ───────────── primitives ─────────────
export type Id = string;        // UUID v4
export type ISODate = string;   // "YYYY-MM-DD" — a calendar day. No time, no time zone, ever.
export type ISODateTime = string; // UTC, e.g. "2026-09-21T03:14:00Z" (audit fields only)
export const DATE_MIN: ISODate = "1997-01-01";  // earliest bookable day (sample history starts Aug 1997)
export const DATE_MAX: ISODate = "2050-12-31";  // latest bookable day; outside → INVALID_RANGE
export const MAX_WINDOW_DAYS = 366;              // /schedule and /bookings: to − from + 1 ≤ this, else 400
export const SOFT_HORIZON_YEARS = 2;             // manual bookings: endDate > asOfDate + 2y → FAR_FUTURE (warning, can still save)
export const HARD_HORIZON_YEARS = 5;             // manual bookings: endDate > asOfDate + 5y → BEYOND_HORIZON (error)
                                                 // "+ N years" = date-fns addYears (Feb 29 → Feb 28). Imports skip both.

// ───────────── projects ─────────────
// A project is a workspace: its own berths, vessels, bookings, imports and "today". All other endpoints live
// under /api/projects/:projectId. No auth: the project id is the access key (infrastructure.md §5).
export type ProjectOrigin = "sample" | "defaults" | "empty";
// sample   = a private copy of the sample template (default fleet + 23 years of imported history)
// defaults = a private copy of the default fleet (6 berths + 2 sections + 164 vessels), no bookings
// empty    = nothing; configure by hand or upload a spreadsheet
export interface Project {
  id: Id;
  name: string;
  origin: ProjectOrigin;
  createdAt: ISODateTime;
  lastOpenedAt: ISODateTime;
  counts: { berths: number; vessels: number; bookings: number };  // bookings = confirmed
}
export interface ProjectInput { name: string; start: ProjectOrigin; }  // "upload your own" = start: "empty", then POST an import
export interface ProjectPatch { name: string; }
export const MAX_PROJECTS_PER_REQUEST = 50;      // GET /api/projects?ids=… (the ids this browser remembers)

// ───────────── reference data ─────────────
export type BerthKind = "berth" | "section";
// "berth"   = exclusive: one occupant per day, length is enforced.
// "section" = shared area (e.g. small-craft slips): overlaps and length are NOT enforced.

export interface Berth {
  id: Id;
  name: string;               // "North Pier West"
  lengthFt: number | null;    // 410; null for sections
  kind: BerthKind;
  active: boolean;            // inactive berths accept no new bookings
  sortOrder: number;          // row order in the schedule grid
}
export interface BerthInput {
  name: string;               // unique, case-insensitive
  kind: BerthKind;
  lengthFt: number | null;    // required (> 0) for "berth"; must be null for "section"
  sortOrder?: number;         // default: after the last berth
}
export interface BerthPatch { name?: string; lengthFt?: number | null; active?: boolean; sortOrder?: number; }

export interface Vessel {
  id: Id;
  name: string;               // full display name incl. prefix: "R/V Golden Compass"
  lengthFt: number | null;    // LOA in feet; null = unknown (legacy imports only)
  draftFt: number | null;
  operator: string | null;
  notes: string | null;
}
export interface VesselInput {
  name: string;
  lengthFt: number;           // required when registering by hand
  draftFt?: number | null;
  operator?: string | null;
  notes?: string | null;
}

// ───────────── bookings ─────────────
export type OccupantType = "vessel" | "event" | "closure";
// vessel  = a boat (has a length, must fit)
// event   = non-vessel use that takes the berth (community sail day, campus event…)
// closure = berth unusable (maintenance, dock repair…)
export type BookingStatus = "confirmed" | "cancelled"; // cancelled bookings occupy nothing

export interface Booking {
  id: Id;
  berthId: Id;                // never null: unassignable legacy rows live in import issues
  occupantType: OccupantType;
  vesselId: Id | null;        // non-null iff occupantType === "vessel"
  title: string;              // vessel name, or event/closure title
  startDate: ISODate;         // INCLUSIVE
  endDate: ISODate;           // INCLUSIVE, >= startDate
  status: BookingStatus;
  notes: string | null;
  source: "manual" | "import";
  version: number;            // optimistic concurrency; +1 on every update
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
export interface BookingView extends Booking {
  berthName: string;
  vesselLengthFt: number | null;
  berthLengthFt: number | null;
}
export interface BookingInput {
  berthId: Id;
  occupantType: OccupantType;
  vesselId?: Id | null;       // required for "vessel"
  title?: string | null;      // required for "event" / "closure"; ignored for "vessel"
  startDate: ISODate;
  endDate: ISODate;
  notes?: string | null;
}
export interface BookingPatch extends Partial<BookingInput> { expectedVersion: number; }

// ───────────── rule violations ─────────────
export type ViolationCode =
  | "INVALID_RANGE"           // endDate < startDate, malformed date, or outside DATE_MIN..DATE_MAX
  | "OVERLAP"                 // another confirmed booking holds the berth on ≥1 of these days
  | "VESSEL_TOO_LONG"         // vessel.lengthFt > berth.lengthFt
  | "VESSEL_LENGTH_UNKNOWN"   // vessel has no length on record
  | "VESSEL_DOUBLE_BERTHED"   // same vessel already booked elsewhere on overlapping days
  | "BERTH_INACTIVE"
  | "IN_PAST"                 // warning only: the whole range is before Settings.asOfDate ("today")
  | "FAR_FUTURE"              // warning, manual only: endDate is more than SOFT_HORIZON_YEARS after asOfDate ("typo?")
  | "BEYOND_HORIZON"          // error, manual only: endDate is more than HARD_HORIZON_YEARS after asOfDate
  | "MISSING_FIELD";
export interface Violation {
  code: ViolationCode;
  severity: "error" | "warning";
  message: string;            // human-readable, safe to show as-is
  bookingIds?: Id[];          // the existing booking(s) in the way
  details?: { vesselLengthFt?: number; berthLengthFt?: number; shortByFt?: number };
}
export interface ValidationResult { ok: boolean; violations: Violation[]; } // ok === no "error" violations
export interface ValidateRequest extends BookingInput { excludeBookingId?: Id; } // for edits

// ───────────── views ─────────────
export interface ScheduleResponse {
  from: ISODate; to: ISODate;      // inclusive window
  berths: Berth[];                 // ordered by sortOrder
  bookings: BookingView[];         // confirmed only, every booking that touches the window, NOT clipped (client clips)
}

export interface AvailabilityOption {
  berth: Berth;
  free: boolean;                   // no overlap in the window
  fits: boolean;                   // vessel length <= berth length (true for sections / no length asked)
  slackFt: number | null;          // berth.lengthFt - vessel length; smaller = tighter fit
  conflicts: { bookingId: Id; title: string; startDate: ISODate; endDate: ISODate }[];
}
export interface AvailabilityResult {
  startDate: ISODate; endDate: ISODate; lengthFt: number | null;
  options: AvailabilityOption[];   // free&fits first, then by slackFt ascending (tightest fit first)
}

// ───────────── import (spreadsheet upload) ─────────────
export type ImportFormat = "template" | "legacy_grid";
// template    = our dock-template.xlsx: sheets Berths, Vessels, Bookings (optional). Creates berths too.
// legacy_grid = the original year-per-sheet grid. Berth labels like "Name - 410'" create the berth if missing.
// Detected from the sheet names; the user doesn't choose.
export type ImportStatus = "previewed" | "committed" | "discarded";
export type IssueCode =
  | "NO_BERTH" | "OVERLAP" | "VESSEL_TOO_LONG" | "VESSEL_DOUBLE_BERTHED"   // row not importable → needs action
  | "OUTSIDE_MONTH_COLUMNS" | "UNPARSEABLE_CELL"                          // couldn't place the cell
  | "HEADER_YEAR_MISMATCH" | "DUPLICATE_CARRYOVER" | "DUPLICATE_EXISTING" | "ANNOTATION_SKIPPED"  // info: handled automatically
  | "UNKNOWN_FORMAT"                     // template or grid? neither → error, nothing staged
  | "TEMPLATE_BAD_HEADER"                // a template sheet's header row doesn't match → error, that sheet skipped
  | "INVALID_VALUE"                      // template cell: bad kind / length / date / type → error, row skipped
  | "DUPLICATE_NAME";                    // same berth/vessel name twice in the file → warning, first kept
export interface ImportedRow {
  berthLabel: string | null;       // raw berth label / Berth column, null for unlabeled overflow rows
  occupantType: OccupantType;
  title: string;
  vesselLengthFt: number | null;   // known length of the matched vessel; null for events or unknown
  startDate: ISODate; endDate: ISODate;
}
export interface ImportIssue {
  id: Id; importId: Id;
  code: IssueCode;
  severity: "error" | "warning" | "info";
  sheet: string; cell: string | null;   // e.g. "2010", "AF44" or "Bookings", "C12"
  message: string;
  row: ImportedRow | null;              // present when a booking could be created from it
  resolved: boolean;
  resolution: "created" | "dismissed" | null;
}
export interface ImportRun {
  id: Id; filename: string; format: ImportFormat; status: ImportStatus;
  createdAt: ISODateTime; committedAt: ISODateTime | null;
  counts: { sheets: number; cells: number; berths: number; vessels: number; bookings: number; issues: number }; // staged, to add
  issueCounts: { error: number; warning: number; info: number };
}
export type ResolveIssueInput =
  | { action: "create_booking"; berthId: Id; vesselLengthFt?: number }
  | { action: "dismiss"; reason?: string };
export interface Page<T> { items: T[]; nextCursor: string | null; }

// ───────────── settings ─────────────
// "Today" is configurable because the sample history ends in 2019: set it to e.g. 2020-01-01 to demo
// a forward-looking schedule on top of the imported past. It drives the default schedule window,
// the "today" marker, and the IN_PAST warning. It never changes what is valid, only what is flagged.
export interface Settings { asOfDate: ISODate; asOfSource: "system" | "override"; }
export interface SettingsPatch { asOfDate: ISODate | null; } // null = revert to the real system date

// ───────────── audit ─────────────
export interface AuditReport {
  generatedAt: ISODateTime;
  checkedBookings: number;
  violations: { bookingId: Id; violations: Violation[] }[];  // expected empty; see backend.md §7
  summary: Partial<Record<ViolationCode, number>>;
}

// ───────────── errors ─────────────
export interface ApiError {
  error: {
    code: "VALIDATION" | "CONFLICT" | "UNPROCESSABLE" | "NOT_FOUND" | "STALE_VERSION"
        | "FORBIDDEN"      // 403: writing to a read-only template project
        | "UNAVAILABLE"    // 503: demo is at its project cap (infrastructure.md §5)
        | "INTERNAL";
    message: string;
    violations?: Violation[];
  };
}

// ═════════════════════════════ Part 2: request schemas ═════════════════════════════
// Shape checks only (→ 400 VALIDATION). Business rules (R1–R6, horizon) live in rules.ts (→ 409/422),
// because they need the database. The one overlap: a start > end range is caught by rules.ts as
// INVALID_RANGE, not here, so the UI gets it as a Violation in the status panel.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const id = z.string().uuid();
const feet = z.number().positive().finite();
const text = z.string().trim().min(1);

export const BookingInputSchema = z.object({
  berthId: id,
  occupantType: z.enum(["vessel", "event", "closure"]),
  vesselId: id.nullish(),
  title: text.nullish(),
  startDate: isoDate,
  endDate: isoDate,
  notes: z.string().nullish(),
}) satisfies z.ZodType<BookingInput>;
export const BookingPatchSchema = BookingInputSchema.partial().extend({ expectedVersion: z.number().int().positive() }) satisfies z.ZodType<BookingPatch>;
export const ValidateRequestSchema = BookingInputSchema.extend({ excludeBookingId: id.optional() }) satisfies z.ZodType<ValidateRequest>;
export const CancelSchema = z.object({ expectedVersion: z.number().int().positive() });

export const VesselInputSchema = z.object({
  name: text,
  lengthFt: feet,
  draftFt: feet.nullish(),
  operator: z.string().nullish(),
  notes: z.string().nullish(),
}) satisfies z.ZodType<VesselInput>;
export const VesselPatchSchema = VesselInputSchema.partial();

export const BerthInputSchema = z.discriminatedUnion("kind", [
  z.object({ name: text, kind: z.literal("berth"), lengthFt: feet, sortOrder: z.number().int().optional() }),
  z.object({ name: text, kind: z.literal("section"), lengthFt: z.null(), sortOrder: z.number().int().optional() }),
]) satisfies z.ZodType<BerthInput>;
export const BerthPatchSchema = z.object({
  name: text.optional(), lengthFt: feet.nullable().optional(), active: z.boolean().optional(), sortOrder: z.number().int().optional(),
}) satisfies z.ZodType<BerthPatch>;

export const ProjectInputSchema = z.object({
  name: text.max(80),
  start: z.enum(["sample", "defaults", "empty"]),
}) satisfies z.ZodType<ProjectInput>;
export const ProjectPatchSchema = z.object({ name: text.max(80) }) satisfies z.ZodType<ProjectPatch>;
export const ProjectsQuerySchema = z.object({
  ids: z.string().transform((v) => v.split(",").filter(Boolean)).pipe(z.array(id).max(MAX_PROJECTS_PER_REQUEST)),
});

export const SettingsPatchSchema = z.object({ asOfDate: isoDate.nullable() }) satisfies z.ZodType<SettingsPatch>;

export const ResolveIssueInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_booking"), berthId: id, vesselLengthFt: feet.optional() }),
  z.object({ action: z.literal("dismiss"), reason: z.string().optional() }),
]) satisfies z.ZodType<ResolveIssueInput>;

// query strings arrive as strings
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
export const WindowQuerySchema = z.object({ from: isoDate, to: isoDate });   // + MAX_WINDOW_DAYS check in the handler
export const BookingsQuerySchema = WindowQuerySchema.extend({
  berthId: id.optional(),
  occupantType: z.enum(["vessel", "event", "closure"]).optional(),
  q: z.string().optional(),
  includeCancelled: bool.optional(),
});
export const AvailabilityQuerySchema = z.object({
  startDate: isoDate, endDate: isoDate,
  vesselId: id.optional(),
  lengthFt: z.coerce.number().positive().optional(),
});
export const VesselsQuerySchema = z.object({ q: z.string().optional(), lengthUnknown: bool.optional() });
export const BerthsQuerySchema = z.object({ includeInactive: bool.optional() });
export const IssuesQuerySchema = z.object({
  severity: z.enum(["error", "warning", "info"]).optional(),
  code: z.string().optional(),
  resolved: bool.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
