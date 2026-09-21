/**
 * The Python parse pipeline's output — the contract between `pipeline/` (Python) and the TS importer.
 * Python answers "what does the file say?"; TS (window + rules.ts) answers "what is allowed?".
 *
 * Python produces this JSON (pipeline/serialize.py); TS validates it with ParsedWorkbookSchema before using it.
 * Nothing here is rule-checked yet: overlaps, fit, double-berthing are decided in TS by rules.ts.
 * Change this file and pipeline/serialize.py together; pipeline/tests check the Python side against the same shape.
 */
import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const occupant = z.enum(["vessel", "event", "closure"]);

export const ParsedBerthSchema = z.object({
  name: z.string().min(1),                 // "North Pier West"
  kind: z.enum(["berth", "section"]),
  lengthFt: z.number().positive().nullable(),
  sortOrder: z.number().int(),
});

export const ParsedVesselSchema = z.object({
  name: z.string().min(1),                 // normalised: "R/V High Drift"
  lengthFt: z.number().positive().nullable(),
  draftFt: z.number().positive().nullable(),
  operator: z.string().nullable(),
  notes: z.string().nullable(),
});

export const ParsedRowSchema = z.object({
  berthLabel: z.string().nullable(),       // matches a ParsedBerth.name or an existing berth; null = no berth
  occupantType: occupant,
  title: z.string().min(1),                // vessel name (matches a ParsedVessel.name) or event/closure title
  startDate: isoDate,                      // INCLUSIVE
  endDate: isoDate,                        // INCLUSIVE
  notes: z.string().nullable(),
  sheet: z.string(),
  cell: z.string().nullable(),             // "AF44" — first cell of the range
  classifiedBy: z.enum(["regex", "template", "model"]),
});

export const ParsedIssueSchema = z.object({
  // parse-level codes only; rule codes (OVERLAP, VESSEL_TOO_LONG, …) are added later by TS
  code: z.enum([
    "NO_BERTH", "OUTSIDE_MONTH_COLUMNS", "UNPARSEABLE_CELL", "HEADER_YEAR_MISMATCH", "DUPLICATE_CARRYOVER",
    "ANNOTATION_SKIPPED", "UNKNOWN_FORMAT", "TEMPLATE_BAD_HEADER", "INVALID_VALUE", "DUPLICATE_NAME", "MODEL_CLASSIFIED",
  ]),
  severity: z.enum(["error", "warning", "info"]),
  sheet: z.string(),
  cell: z.string().nullable(),
  message: z.string(),
  row: ParsedRowSchema.nullable(),         // present when a booking could still be made from it (NO_BERTH, UNPARSEABLE_CELL…)
});

export const ParsedWorkbookSchema = z.object({
  version: z.literal(1),
  format: z.enum(["template", "legacy_grid"]).nullable(),   // null = UNKNOWN_FORMAT
  stats: z.object({ sheets: z.number().int(), cells: z.number().int(), modelCalls: z.number().int() }),
  berths: z.array(ParsedBerthSchema),
  vessels: z.array(ParsedVesselSchema),
  rows: z.array(ParsedRowSchema),          // bookable rows (berth known); NOT window-filtered, NOT rule-checked
  issues: z.array(ParsedIssueSchema),
});

export type ParsedBerth = z.infer<typeof ParsedBerthSchema>;
export type ParsedVessel = z.infer<typeof ParsedVesselSchema>;
export type ParsedRow = z.infer<typeof ParsedRowSchema>;
export type ParsedIssue = z.infer<typeof ParsedIssueSchema>;
export type ParsedWorkbook = z.infer<typeof ParsedWorkbookSchema>;
