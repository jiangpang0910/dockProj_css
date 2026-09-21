/**
 * ParsedWorkbook (what the file says) → StagePlan (what may go in). Pure: the caller loads the project's
 * existing berths / vessels / confirmed bookings once and persists the plan. backend.md §6.
 *
 *   1 planning window: rows not touching [from, to] are counted and skipped (issues with such rows too)
 *   2 match berths / vessels to the project (by normalised, case-insensitive name) or stage new ones
 *   3 earliest-first through rules.ts (source "import") on a MemoryStore → pass: staged; fail: a conflict
 *
 * Nothing is rejected wholesale: every row ends up staged, a conflict (readable but can't be placed), an issue
 * (couldn't be read properly), a duplicate note, or outside the window.
 */
import { randomUUID } from "node:crypto";
import type { Berth, BookingInput, ConflictType, ImportFormat, IssueCode, ISODate, OccupantType, Vessel, ViolationCode } from "@shared/contract";
import type { ParsedIssue, ParsedRow, ParsedWorkbook } from "@shared/pipeline";
import { MemoryStore, validateBooking } from "../domain/rules";
import { normalizeName } from "../services/mappers";

export interface ExistingBooking {
  id: string;
  berthId: string;
  berthName: string;
  vesselId: string | null;
  title: string;
  startDate: ISODate;
  endDate: ISODate;
}

export interface StageInput {
  parsed: ParsedWorkbook;
  /** null = no window (seeding the sample template takes everything) */
  window: { from: ISODate; to: ISODate } | null;
  existing: { berths: Berth[]; vessels: Vessel[]; bookings: ExistingBooking[] };
}

export interface StagedBerth { id: string; name: string; kind: Berth["kind"]; lengthFt: number | null; sortOrder: number }
export interface StagedVessel {
  id: string; name: string; lengthFt: number | null; draftFt: number | null; operator: string | null; notes: string | null;
  isNew: boolean; // false = matches a vessel already in the project (commit keeps the existing one)
}
export interface StagedBooking {
  id: string;
  berthId: string | null;        // an existing berth…
  stagedBerthId: string | null;  // …or one staged from this file
  occupantType: OccupantType;
  stagedVesselId: string | null;
  title: string | null;          // events/closures only
  startDate: ISODate; endDate: ISODate;
  notes: string | null;
}
export interface IssueRow {
  berthLabel: string | null; occupantType: OccupantType; title: string;
  startDate: ISODate; endDate: ISODate; classifiedBy: ParsedRow["classifiedBy"]; notes: string | null;
}
export interface StagedIssue {
  code: IssueCode; severity: "error" | "warning" | "info";
  sheet: string; cell: string | null; message: string; row: IssueRow | null;
}
/** A row that read fine but can't be placed. Names, not ids: its berth/vessel may only be staged so far. */
export interface StagedConflict {
  type: ConflictType;
  occupantType: OccupantType; title: string;
  berthLabel: string | null;     // what the file said
  berthName: string | null;      // the berth it matched (null: none / unknown)
  vesselName: string | null;     // vessel rows only
  startDate: ISODate; endDate: ISODate; notes: string | null;
  sheet: string; cell: string | null; message: string;
}
export interface StagePlan {
  format: ImportFormat;
  berths: StagedBerth[];
  vessels: StagedVessel[];
  bookings: StagedBooking[];
  issues: StagedIssue[];
  conflicts: StagedConflict[];
  outsideWindow: number;
}

const key = (name: string) => normalizeName(name).toLowerCase();

/** A rule violation found at import → a conflict (placeable later) or, for bad data, an issue. */
const CONFLICT_FOR: Partial<Record<ViolationCode, ConflictType>> = {
  OVERLAP: "OVERLAP",
  VESSEL_TOO_LONG: "VESSEL_TOO_LONG",
  VESSEL_DOUBLE_BERTHED: "VESSEL_DOUBLE_BERTHED",
  BERTH_INACTIVE: "BERTH_INACTIVE",
};
const ISSUE_FOR: Partial<Record<ViolationCode, IssueCode>> = { INVALID_RANGE: "INVALID_VALUE", MISSING_FIELD: "INVALID_VALUE" };

const issueRow = (r: ParsedRow): IssueRow => ({
  berthLabel: r.berthLabel, occupantType: r.occupantType, title: r.title,
  startDate: r.startDate, endDate: r.endDate, classifiedBy: r.classifiedBy, notes: r.notes,
});

export async function stage({ parsed, window, existing }: StageInput): Promise<StagePlan> {
  if (!parsed.format) throw new Error("stage() needs a recognised format");
  const template = parsed.format === "template";
  const touches = (r: { startDate: ISODate; endDate: ISODate }) =>
    !window || (r.startDate <= window.to && r.endDate >= window.from);

  const issues: StagedIssue[] = [];
  const berthsOut: StagedBerth[] = [];
  const vesselsOut: StagedVessel[] = [];
  const bookingsOut: StagedBooking[] = [];
  const conflictsOut: StagedConflict[] = [];
  let outsideWindow = 0;

  // ── berths: existing by name, else staged (both formats may define berths) ──
  const berthByKey = new Map<string, { berth: Berth; staged: boolean }>();
  for (const b of existing.berths) berthByKey.set(key(b.name), { berth: b, staged: false });
  let nextOrder = Math.max(0, ...existing.berths.map((b) => b.sortOrder));
  for (const pb of [...parsed.berths].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const k = key(pb.name);
    if (berthByKey.has(k)) {
      if (template) issues.push({ code: "DUPLICATE_EXISTING", severity: "info", sheet: "Berths", cell: null,
        message: `Berth "${pb.name}" already exists in this project; the existing one is kept.`, row: null });
      continue;
    }
    const sb: StagedBerth = { id: randomUUID(), name: normalizeName(pb.name), kind: pb.kind,
      lengthFt: pb.kind === "berth" ? pb.lengthFt : null, sortOrder: ++nextOrder };
    berthsOut.push(sb);
    berthByKey.set(k, { berth: { ...sb, active: true }, staged: true });
  }

  // ── vessels: existing by name; the file's own list gives lengths for new ones ──
  const existingVessel = new Map(existing.vessels.map((v) => [key(v.name), v]));
  const parsedVessel = new Map(parsed.vessels.map((v) => [key(v.name), v]));
  const stagedVessel = new Map<string, StagedVessel>(); // by key; added to vesselsOut when first used (grid) or up front (template)
  const storeVessels: Vessel[] = [...existing.vessels];

  const vesselFor = (name: string): StagedVessel => {
    const k = key(name);
    let sv = stagedVessel.get(k);
    if (sv) return sv;
    const ex = existingVessel.get(k);
    if (ex) {
      sv = { ...ex, id: randomUUID(), isNew: false };
      // rules must see the *existing* vessel's id so R4 finds its existing bookings
      stagedVessel.set(k, sv);
      return sv;
    }
    const pv = parsedVessel.get(k);
    sv = { id: randomUUID(), name: normalizeName(pv?.name ?? name), lengthFt: pv?.lengthFt ?? null,
      draftFt: pv?.draftFt ?? null, operator: pv?.operator ?? null, notes: pv?.notes ?? null, isNew: true };
    stagedVessel.set(k, sv);
    storeVessels.push({ id: sv.id, name: sv.name, lengthFt: sv.lengthFt, draftFt: sv.draftFt, operator: sv.operator, notes: sv.notes });
    return sv;
  };
  /** The id rules.ts should use: the existing vessel's (for R4 against live bookings) or the staged one's. */
  const ruleVesselId = (sv: StagedVessel) => (sv.isNew ? sv.id : existingVessel.get(key(sv.name))!.id);
  const used = new Set<string>();
  const markUsed = (sv: StagedVessel) => { if (!used.has(sv.id)) { used.add(sv.id); vesselsOut.push(sv); } };

  /** Record a claim that can't be placed. Its vessel is still brought in, so placing it later needs nothing else. */
  const conflict = (type: ConflictType, r: ParsedRow, berthName: string | null, message: string) => {
    const sv = r.occupantType === "vessel" ? vesselFor(r.title) : null;
    if (sv) markUsed(sv);
    conflictsOut.push({ type, occupantType: r.occupantType, title: sv?.name ?? r.title, berthLabel: r.berthLabel,
      berthName, vesselName: sv?.name ?? null, startDate: r.startDate, endDate: r.endDate, notes: r.notes,
      sheet: r.sheet, cell: r.cell, message });
  };

  if (template) {
    // A Vessels sheet is the user's fleet: bring every vessel in, even without bookings.
    for (const pv of parsed.vessels) {
      if (existingVessel.has(key(pv.name))) {
        issues.push({ code: "DUPLICATE_EXISTING", severity: "info", sheet: "Vessels", cell: null,
          message: `Vessel "${pv.name}" already exists in this project; the existing one is kept.`, row: null });
      }
      markUsed(vesselFor(pv.name));
    }
  }

  // ── the rules store: existing confirmed bookings + everything accepted so far ──
  const store = new MemoryStore([...berthByKey.values()].map((b) => b.berth), storeVessels);
  const dupKeys = new Set<string>();
  for (const b of existing.bookings) {
    store.add({ id: b.id, title: b.title, berthId: b.berthId, berthName: b.berthName, vesselId: b.vesselId,
      startDate: b.startDate, endDate: b.endDate });
    dupKeys.add(`${b.berthId}|${key(b.title)}|${b.startDate}|${b.endDate}`);
  }

  // ── rows, earliest first: the earlier booking wins an overlap ──
  const rows = [...parsed.rows].sort((a, b) =>
    a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0);

  for (const r of rows) {
    if (!touches(r)) { outsideWindow++; continue; }
    const where = { sheet: r.sheet, cell: r.cell };

    const hit = r.berthLabel ? berthByKey.get(key(r.berthLabel)) : undefined;
    if (!hit) {
      if (r.startDate > r.endDate) {
        issues.push({ code: "INVALID_VALUE", severity: "error", ...where, row: issueRow(r), message: "End is before start; row skipped." });
      } else {
        conflict("NO_BERTH", r, null, r.berthLabel ? `No berth named "${r.berthLabel}" in this project or the file.` : "This entry has no berth.");
      }
      continue;
    }
    const berth = hit.berth;

    if (dupKeys.has(`${berth.id}|${key(r.title)}|${r.startDate}|${r.endDate}`)) {
      issues.push({ code: "DUPLICATE_EXISTING", severity: "info", ...where, row: issueRow(r),
        message: `${r.title} on ${berth.name} for these dates is already in the schedule; skipped.` });
      continue;
    }

    const isVessel = r.occupantType === "vessel";
    const sv = isVessel ? vesselFor(r.title) : null;
    const input: BookingInput = {
      berthId: berth.id, occupantType: r.occupantType,
      vesselId: sv ? ruleVesselId(sv) : null, title: isVessel ? null : r.title,
      startDate: r.startDate, endDate: r.endDate,
    };
    const errors = (await validateBooking(input, store, { source: "import", asOfDate: window?.from ?? r.startDate }))
      .filter((v) => v.severity === "error");
    if (errors.length) {
      const message = errors.map((v) => v.message).join(" ");
      const bad = errors.find((v) => ISSUE_FOR[v.code]);
      if (bad) issues.push({ code: ISSUE_FOR[bad.code]!, severity: "error", ...where, row: issueRow(r), message });
      else conflict(CONFLICT_FOR[errors[0].code] ?? "OVERLAP", r, berth.name, message);
      continue;
    }

    const id = randomUUID();
    store.add({ id, title: sv?.name ?? r.title, berthId: berth.id, berthName: berth.name, vesselId: input.vesselId ?? null,
      startDate: r.startDate, endDate: r.endDate });
    dupKeys.add(`${berth.id}|${key(r.title)}|${r.startDate}|${r.endDate}`);
    if (sv) markUsed(sv);
    bookingsOut.push({
      id, berthId: hit.staged ? null : berth.id, stagedBerthId: hit.staged ? berth.id : null,
      occupantType: r.occupantType, stagedVesselId: sv?.id ?? null, title: isVessel ? null : r.title,
      startDate: r.startDate, endDate: r.endDate, notes: r.notes,
    });
  }

  // ── parse-level issues: drop the ones whose row is outside the window; keep row-less ones ──
  for (const pi of parsed.issues as ParsedIssue[]) {
    if (pi.row && !touches(pi.row)) continue;
    if (pi.code === "NO_BERTH") {   // readable, just unplaced → a conflict; unless its dates are backwards
      if (pi.row && pi.row.startDate <= pi.row.endDate) conflict("NO_BERTH", pi.row, null, pi.message);
      else issues.push({ code: "INVALID_VALUE", severity: "error", sheet: pi.sheet, cell: pi.cell,
        message: `${pi.message} Its end is also before its start; row skipped.`, row: pi.row ? issueRow(pi.row) : null });
      continue;
    }
    issues.push({ code: pi.code, severity: pi.severity, sheet: pi.sheet, cell: pi.cell, message: pi.message,
      row: pi.row ? issueRow(pi.row) : null });
  }

  return { format: parsed.format, berths: berthsOut, vessels: vesselsOut, bookings: bookingsOut, issues, conflicts: conflictsOut, outsideWindow };
}
