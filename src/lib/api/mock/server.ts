// In-browser mock of the API (NEXT_PUBLIC_API_MOCK=1). Implements every row of frontend.md §7.2 against an
// in-memory world persisted to localStorage, with the same status codes and ApiError shapes as the real server.
import {
  HARD_HORIZON_YEARS, MAX_WINDOW_DAYS,
  CONFLICT_TYPES,
  type ApiError, type AuditReport, type AvailabilityOption, type Berth, type Booking, type BookingInput,
  type BookingView, type Conflict, type ConflictSummary, type ConflictType, type ImportIssue, type ImportRun, type ISODate,
  type Project, type ProjectOrigin, type Settings, type Vessel, type Violation,
} from "@shared/contract";
import { addDays, addYears, diffDays, isISODate, todayIn } from "@/lib/dates";
import { defaultBerths, defaultVessels, newId, sampleProject } from "./fixtures";
import { UnknownEntity, validate } from "./rules";

interface StagedRow { berthId: string; occupantType: Booking["occupantType"]; vesselName: string | null; vesselLengthFt: number | null; title: string; startDate: ISODate; endDate: ISODate }
/** A claim the import couldn't place; berth/vessel by name until commit (like the real staging). */
interface StagedConflict { type: ConflictType; occupantType: Booking["occupantType"]; title: string; berthName: string | null; vesselLengthFt: number | null; startDate: ISODate; endDate: ISODate; sheet: string; cell: string; message: string }
interface MockImport { run: ImportRun; issues: ImportIssue[]; staged: StagedRow[]; conflicts?: StagedConflict[] }
interface MockProject {
  meta: Omit<Project, "counts">;
  asOfDate: ISODate | null;
  berths: Berth[]; vessels: Vessel[]; bookings: Booking[];
  imports: MockImport[];
  conflicts?: Conflict[];   // stored without live fields (blockers, lengths): see conflictOut
}
interface World { projects: Record<string, MockProject> }

const KEY = "dock.mock.v1";
let world: World | null = null;
function load(): World {
  if (world) return world;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    world = raw ? (JSON.parse(raw) as World) : { projects: {} };
  } catch { world = { projects: {} }; }
  return world;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(world)); } catch { /* quota / private mode: keep in memory */ }
}

// ───────── responses ─────────
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, code: ApiError["error"]["code"], message: string, violations?: Violation[]) =>
  json(status, { error: { code, message, ...(violations ? { violations } : {}) } } satisfies ApiError);
const nowTs = () => new Date().toISOString();

const sleep = (ms: number, signal?: AbortSignal | null) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); });
});

// ───────── helpers ─────────
const asOf = (p: MockProject): Settings =>
  p.asOfDate ? { asOfDate: p.asOfDate, asOfSource: "override" } : { asOfDate: todayIn(), asOfSource: "system" };
function projectOut(p: MockProject): Project {
  return { ...p.meta, counts: { berths: p.berths.length, vessels: p.vessels.length, bookings: p.bookings.filter((b) => b.status === "confirmed").length } };
}
function view(p: MockProject, b: Booking): BookingView {
  const berth = p.berths.find((x) => x.id === b.berthId);
  const vessel = b.vesselId ? p.vessels.find((v) => v.id === b.vesselId) : undefined;
  return { ...b, title: vessel?.name ?? b.title, berthName: berth?.name ?? "?", berthLengthFt: berth?.lengthFt ?? null, vesselLengthFt: vessel?.lengthFt ?? null };
}
const sortedBerths = (p: MockProject) => [...p.berths].sort((a, b) => a.sortOrder - b.sortOrder);
const normName = (s: string) => s.trim().replace(/\s+/g, " ");
function windowOk(from?: string | null, to?: string | null) {
  if (!isISODate(from) || !isISODate(to) || to < from) return "from and to must be dates with from ≤ to.";
  if (diffDays(from, to) + 1 > MAX_WINDOW_DAYS) return `A window can be at most ${MAX_WINDOW_DAYS} days.`;
  return null;
}
function rulesResponse(violations: Violation[]): Response | null {
  const errors = violations.filter((v) => v.severity === "error");
  if (!errors.length) return null;
  const conflict = errors.some((v) => v.code === "OVERLAP" || v.code === "VESSEL_DOUBLE_BERTHED");
  const msg = errors.length === 1 ? errors[0].message : `${errors.length} problems with this booking.`;
  return fail(conflict ? 409 : 422, conflict ? "CONFLICT" : "UNPROCESSABLE", msg, violations);
}

function createProjectWorld(name: string, start: ProjectOrigin, asOfDate?: ISODate | null): MockProject {
  const meta = { id: newId(), name, origin: start, createdAt: nowTs(), lastOpenedAt: nowTs() };
  if (start === "sample") {
    const s = sampleProject();
    const p: MockProject = { meta, asOfDate: s.asOfDate, berths: s.berths, vessels: s.vessels, bookings: s.bookings, imports: [] };
    p.conflicts = sampleConflicts(p).map((c) => openConflict(p, c, null));
    return p;
  }
  if (start === "defaults") return { meta, asOfDate: asOfDate ?? null, berths: defaultBerths(), vessels: defaultVessels(), bookings: [], imports: [] };
  return { meta, asOfDate: asOfDate ?? null, berths: [], vessels: [], bookings: [], imports: [] };
}

// ───────── conflicts ─────────
function openConflict(p: MockProject, c: StagedConflict, importId: string | null): Conflict {
  const berth = c.berthName ? p.berths.find((b) => b.name.toLowerCase() === c.berthName!.toLowerCase()) : undefined;
  const vessel = c.occupantType === "vessel" ? findOrCreateVessel(p, c.title, c.vesselLengthFt) : undefined;
  return {
    id: newId(), importId, type: c.type, status: "open", occupantType: c.occupantType, title: vessel?.name ?? c.title,
    vesselId: vessel?.id ?? null, vesselLengthFt: null, berthId: berth?.id ?? null, berthName: berth?.name ?? null, berthLengthFt: null,
    berthLabel: c.berthName, startDate: c.startDate, endDate: c.endDate, notes: null, sheet: c.sheet, cell: c.cell, message: c.message,
    blockers: [], bookingId: null, bookingIds: [], resolutionNote: null, createdAt: nowTs(), resolvedAt: null,
  };
}
/** Live fields, as the server computes them on read. */
function conflictOut(p: MockProject, c: Conflict): Conflict {
  const berth = p.berths.find((b) => b.id === c.berthId);
  const vessel = p.vessels.find((v) => v.id === c.vesselId);
  const hits = c.status !== "open" ? [] : p.bookings.filter((b) => b.status === "confirmed" && b.startDate <= c.endDate && b.endDate >= c.startDate &&
    ((c.type === "OVERLAP" && b.berthId === c.berthId && berth?.kind === "berth") || (c.type === "VESSEL_DOUBLE_BERTHED" && b.vesselId === c.vesselId)));
  return {
    ...c, berthName: berth?.name ?? c.berthName, berthLengthFt: berth?.lengthFt ?? null, vesselLengthFt: vessel?.lengthFt ?? null,
    blockers: hits.map((b) => { const v = view(p, b); return { bookingId: b.id, title: v.title, berthName: v.berthName, startDate: b.startDate, endDate: b.endDate }; }),
  };
}
/** The sample ships with a season's worth of rows the legacy workbook couldn't place. */
function sampleConflicts(p: MockProject): StagedConflict[] {
  const out: StagedConflict[] = [];
  const exclusive = sortedBerths(p).filter((b) => b.kind === "berth");
  const shortest = [...exclusive].sort((a, b) => (a.lengthFt ?? 0) - (b.lengthFt ?? 0))[0];
  const long = p.vessels.filter((v) => (v.lengthFt ?? 0) > (shortest?.lengthFt ?? Infinity)).slice(0, 4);
  const known = p.vessels.filter((v) => v.lengthFt != null);
  const booked = p.bookings.filter((b) => b.vesselId && exclusive.some((e) => e.id === b.berthId)).slice(0, 60);
  booked.filter((_, i) => i % 6 === 0).forEach((b, i) => {
    const other = known[(i * 7 + 3) % known.length];
    const berth = p.berths.find((x) => x.id === b.berthId)!;
    out.push({ type: "OVERLAP", occupantType: "vessel", title: other.name, berthName: berth.name, vesselLengthFt: other.lengthFt,
      startDate: b.startDate, endDate: addDays(b.startDate, 1), sheet: "2019", cell: `H${20 + i}`,
      message: `${berth.name} is already held on ${b.startDate} by an earlier row.` });
  });
  long.forEach((v, i) => out.push({ type: "VESSEL_TOO_LONG", occupantType: "vessel", title: v.name, berthName: shortest.name, vesselLengthFt: v.lengthFt,
    startDate: addDays("2019-06-03", i * 9), endDate: addDays("2019-06-05", i * 9), sheet: "2019", cell: `P${14 + i}`,
    message: `${v.name} (${v.lengthFt}′) is ${(v.lengthFt ?? 0) - (shortest.lengthFt ?? 0)}′ too long for ${shortest.name} (${shortest.lengthFt}′).` }));
  booked.filter((_, i) => i % 11 === 5).forEach((b, i) => {
    const v = p.vessels.find((x) => x.id === b.vesselId)!;
    const elsewhere = exclusive.find((e) => e.id !== b.berthId && (e.lengthFt ?? 0) >= (v.lengthFt ?? 0)) ?? exclusive[0];
    out.push({ type: "VESSEL_DOUBLE_BERTHED", occupantType: "vessel", title: v.name, berthName: elsewhere.name, vesselLengthFt: v.lengthFt,
      startDate: b.startDate, endDate: b.endDate, sheet: "2019", cell: `T${30 + i}`, message: `${v.name} is already at another berth on these days.` });
  });
  ["R/V Golden Compass", "S/V Far Horizon", "Bunker barge", "Sea Scouts overnight", "F/V Long Drift", "M/V Harbor Light", "Tug Western Current"].forEach((t, i) =>
    out.push({ type: "NO_BERTH", occupantType: /scouts/i.test(t) ? "event" : "vessel", title: t, berthName: null, vesselLengthFt: null,
      startDate: addDays("2019-07-02", i * 6), endDate: addDays("2019-07-03", i * 6), sheet: "2019", cell: `K${41 + i}`,
      message: `"${t}" is on an unlabeled row, so its berth is unknown.` }));
  return out;
}

// A fake parse of an uploaded workbook: berths/vessels matched to the project, a handful of staged rows,
// and issues of every kind the triage screen must handle.
function fakeImport(p: MockProject, file: File | null, planTo?: string): MockImport {
  const from = asOf(p).asOfDate;
  const to = planTo && isISODate(planTo) ? planTo : addYears(from, HARD_HORIZON_YEARS);
  const filename = file?.name ?? "upload.xlsx";
  const format = /template/i.test(filename) ? "template" : "legacy_grid";
  const id = newId();
  if (!p.berths.length) p.berths = defaultBerths();   // a legacy grid creates berths from its labels
  const berths = sortedBerths(p).filter((b) => b.kind === "berth");
  const d = (n: number) => addDays(from, n);
  const staged: StagedRow[] = [];
  const vesselNames = ["R/V Northern Meridian", "F/V Swift Dory", "S/V Iron Petrel", "M/V Swift Petrel", "Tug Western Current"];
  for (let i = 0; i < 14; i++) {
    const b = berths[i % berths.length];
    const s = d(3 + i * 4), e = d(3 + i * 4 + (i % 3));
    if (i % 5 === 4) staged.push({ berthId: b.id, occupantType: "event", vesselName: null, vesselLengthFt: null, title: "Community sail day", startDate: s, endDate: s });
    else staged.push({ berthId: b.id, occupantType: "vessel", vesselName: vesselNames[i % vesselNames.length], vesselLengthFt: 40 + (i % 3) * 5, title: vesselNames[i % vesselNames.length], startDate: s, endDate: e });
  }
  const mkIssue = (code: ImportIssue["code"], severity: ImportIssue["severity"], sheet: string, cell: string | null, message: string, row: ImportIssue["row"]): ImportIssue =>
    ({ id: newId(), importId: id, code, severity, sheet, cell, message, row, resolved: false, resolution: null });
  const yr = from.slice(0, 4);
  const conflicts: StagedConflict[] = [
    { type: "NO_BERTH", occupantType: "vessel", title: "R/V Golden Compass", berthName: null, vesselLengthFt: 124, startDate: d(10), endDate: d(13), sheet: yr, cell: "K41",
      message: "This row sits on an unlabeled overflow line, so its berth is unknown." },
    { type: "NO_BERTH", occupantType: "vessel", title: "S/V Far Horizon", berthName: null, vesselLengthFt: null, startDate: d(20), endDate: d(21), sheet: yr, cell: "S43",
      message: "This row sits on an unlabeled overflow line, so its berth is unknown." },
    { type: "OVERLAP", occupantType: "vessel", title: "F/V Long Drift", berthName: staged[0] ? p.berths.find((b) => b.id === staged[0].berthId)!.name : null, vesselLengthFt: 60,
      startDate: staged[0]?.startDate ?? d(3), endDate: staged[0]?.startDate ?? d(3), sheet: yr, cell: "H12", message: "The berth is already held on those days by an earlier row." },
    { type: "VESSEL_TOO_LONG", occupantType: "vessel", title: "R/V High Drift", berthName: "South Float East", vesselLengthFt: 120, startDate: d(30), endDate: d(33), sheet: yr, cell: "P18",
      message: "R/V High Drift (120′) is 30′ too long for South Float East (90′)." },
  ];
  const issues: ImportIssue[] = [
    mkIssue("MODEL_CLASSIFIED", "info", yr, "W22", "“Sea Scouts overnight” didn't match a pattern; the model classified it as an event.",
      { berthLabel: berths[1]?.name ?? null, occupantType: "event", title: "Sea Scouts overnight", vesselLengthFt: null, startDate: d(45), endDate: d(45), classifiedBy: "model" }),
    mkIssue("UNPARSEABLE_CELL", "warning", yr, "AB30", "Couldn't tell what “Hull survey – yard” is.",
      { berthLabel: berths[2]?.name ?? null, occupantType: "closure", title: "Hull survey – yard", vesselLengthFt: null, startDate: d(52), endDate: d(53), classifiedBy: "regex" }),
    mkIssue("OUTSIDE_MONTH_COLUMNS", "warning", yr, "B19", "This cell sits before day 1 of its month block (a carry-over from the previous month).", null),
    mkIssue("HEADER_YEAR_MISMATCH", "info", "2010", "A60", "Header says “NOVEMBER 2018” but the weekday letters match 2010; used 2010.", null),
    mkIssue("DUPLICATE_CARRYOVER", "info", "2003", "A2", "December 2002 is repeated at the top of the 2003 sheet; the copy was dropped.", null),
    ...["ETA 1200", "Fuel truck 0800", "Departs AM", "Water only"].map((t, i) =>
      mkIssue("ANNOTATION_SKIPPED", "info", yr, `F${50 + i}`, `“${t}” is an operational note, not a booking.`, null)),
  ];
  const run: ImportRun = {
    id, filename, format, status: "previewed", createdAt: nowTs(), committedAt: null, window: { from, to },
    counts: { sheets: format === "template" ? 3 : 23, cells: 9214, berths: 0, vessels: vesselNames.length, bookings: staged.length, outsideWindow: 1812,
      issues: issues.length, conflicts: conflicts.length },
    issueCounts: { error: 0, warning: 0, info: 0 },
    conflictCounts: conflicts.reduce<ImportRun["conflictCounts"]>((m, c) => ({ ...m, [c.type]: (m[c.type] ?? 0) + 1 }), {}),
  };
  recount({ run, issues, staged });
  return { run, issues, staged, conflicts };
}
function recount(imp: MockImport) {
  const open = imp.issues;
  imp.run.issueCounts = {
    error: open.filter((i) => i.severity === "error").length,
    warning: open.filter((i) => i.severity === "warning").length,
    info: open.filter((i) => i.severity === "info").length,
  };
  imp.run.counts.issues = open.length;
}
function findOrCreateVessel(p: MockProject, name: string, lengthFt: number | null): Vessel {
  const found = p.vessels.find((v) => v.name.toLowerCase() === name.toLowerCase());
  if (found) { if (found.lengthFt == null && lengthFt != null) found.lengthFt = lengthFt; return found; }
  const v: Vessel = { id: newId(), name, lengthFt, draftFt: null, operator: null, notes: null };
  p.vessels.push(v);
  return v;
}

// ───────── router ─────────
export async function mockFetch(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url, "http://mock.local");
  const method = (init.method ?? "GET").toUpperCase();
  const seg = u.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const q = u.searchParams;
  const body = (): Record<string, unknown> => {
    if (typeof init.body === "string") { try { return JSON.parse(init.body); } catch { return {}; } }
    return {};
  };
  // realistic latency; the validate call is fast like the real one
  await sleep(seg.includes("validate") ? 90 : seg.includes("imports") && method === "POST" ? 900 : 160 + Math.random() * 180, init.signal);
  const w = load();

  if (seg[0] === "health") return json(200, { ok: true });
  if (seg[0] !== "projects") return fail(404, "NOT_FOUND", "No such endpoint.");

  // /projects
  if (seg.length === 1) {
    if (method === "GET") {
      const ids = (q.get("ids") ?? "").split(",").filter(Boolean);
      return json(200, ids.map((id) => w.projects[id]).filter(Boolean).map(projectOut));
    }
    if (method === "POST") {
      const b = body() as { name?: string; start?: ProjectOrigin; asOfDate?: ISODate | null };
      if (!b.name?.trim() || !b.start) return fail(400, "VALIDATION", "Name and starting point are required.");
      if (Object.keys(w.projects).length >= 300) return fail(503, "UNAVAILABLE", "The demo is full right now — try again tomorrow.");
      const p = createProjectWorld(b.name.trim(), b.start, b.asOfDate);
      w.projects[p.meta.id] = p; save();
      return json(201, projectOut(p));
    }
  }
  const p = w.projects[seg[1]];
  if (!p) return fail(404, "NOT_FOUND", "This project no longer exists (projects are removed after 14 idle days).");
  const rest = seg.slice(2);
  const settings = asOf(p);

  try {
    if (rest.length === 0) {
      if (method === "GET") { p.meta.lastOpenedAt = nowTs(); save(); return json(200, projectOut(p)); }
      if (method === "PATCH") { const n = String(body().name ?? "").trim(); if (!n) return fail(400, "VALIDATION", "Name is required."); p.meta.name = n; save(); return json(200, projectOut(p)); }
      if (method === "DELETE") { delete w.projects[p.meta.id]; save(); return json(204, null); }
    }
    const [res, id, sub, subId, action] = rest;

    // settings
    if (res === "settings") {
      if (method === "GET") return json(200, settings);
      if (method === "PUT") {
        const v = body().asOfDate as string | null;
        if (v !== null && !isISODate(v)) return fail(400, "VALIDATION", "asOfDate must be YYYY-MM-DD or null.");
        p.asOfDate = v; save(); return json(200, asOf(p));
      }
    }

    // berths
    if (res === "berths") {
      if (!id && method === "GET") return json(200, sortedBerths(p).filter((b) => q.get("includeInactive") === "true" || b.active));
      if (!id && method === "POST") {
        const b = body() as { name?: string; kind?: Berth["kind"]; lengthFt?: number | null; sortOrder?: number };
        const name = normName(String(b.name ?? ""));
        if (!name || !b.kind) return fail(400, "VALIDATION", "Name and kind are required.");
        if (b.kind === "berth" && !(Number(b.lengthFt) > 0)) return fail(400, "VALIDATION", "A berth needs a length in feet.");
        if (p.berths.some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail(409, "CONFLICT", `A berth called “${name}” already exists.`);
        const berth: Berth = { id: newId(), name, kind: b.kind, lengthFt: b.kind === "berth" ? Number(b.lengthFt) : null, active: true,
                               sortOrder: b.sortOrder ?? Math.max(0, ...p.berths.map((x) => x.sortOrder)) + 1 };
        p.berths.push(berth); save(); return json(201, berth);
      }
      const berth = p.berths.find((b) => b.id === id);
      if (!berth) return fail(404, "NOT_FOUND", "No such berth.");
      if (method === "PATCH") {
        const b = body() as { name?: string; lengthFt?: number | null; active?: boolean; sortOrder?: number };
        if (b.name !== undefined) {
          const name = normName(b.name);
          if (p.berths.some((x) => x.id !== berth.id && x.name.toLowerCase() === name.toLowerCase())) return fail(409, "CONFLICT", `A berth called “${name}” already exists.`);
          berth.name = name;
        }
        if (b.lengthFt !== undefined && berth.kind === "berth" && b.lengthFt !== berth.lengthFt) {
          const newLen = Number(b.lengthFt);
          const broken = p.bookings.filter((x) => x.berthId === berth.id && x.status === "confirmed" && x.vesselId &&
            (p.vessels.find((v) => v.id === x.vesselId)?.lengthFt ?? 0) > newLen);
          if (broken.length) return fail(409, "CONFLICT", `${broken.length} booking(s) have a vessel longer than ${newLen}′.`,
            [{ code: "VESSEL_TOO_LONG", severity: "error", message: `Shortening ${berth.name} to ${newLen}′ would leave ${broken.length} booked vessel(s) too long.`, bookingIds: broken.map((x) => x.id) }]);
          berth.lengthFt = newLen;
        }
        if (b.active !== undefined) berth.active = b.active;
        if (b.sortOrder !== undefined) berth.sortOrder = b.sortOrder;
        save(); return json(200, berth);
      }
      if (method === "DELETE") {
        const n = p.bookings.filter((x) => x.berthId === berth.id).length;
        if (n) return fail(409, "CONFLICT", `Used by ${n} booking${n === 1 ? "" : "s"} — can't delete. Deactivate it instead.`);
        p.berths = p.berths.filter((b) => b.id !== berth.id); save(); return json(204, null);
      }
    }

    // vessels
    if (res === "vessels") {
      if (!id && method === "GET") {
        const term = (q.get("q") ?? "").toLowerCase();
        return json(200, p.vessels.filter((v) => (!term || v.name.toLowerCase().includes(term)) && (q.get("lengthUnknown") !== "true" || v.lengthFt == null))
          .sort((a, b) => a.name.localeCompare(b.name)));
      }
      if (!id && method === "POST") {
        const b = body() as { name?: string; lengthFt?: number; draftFt?: number | null; operator?: string | null; notes?: string | null };
        const name = normName(String(b.name ?? ""));
        if (!name || !(Number(b.lengthFt) > 0)) return fail(400, "VALIDATION", "Name and a length in feet are required.");
        if (p.vessels.some((v) => v.name.toLowerCase() === name.toLowerCase())) return fail(409, "CONFLICT", `${name} is already registered.`);
        const v: Vessel = { id: newId(), name, lengthFt: Number(b.lengthFt), draftFt: b.draftFt ?? null, operator: b.operator ?? null, notes: b.notes ?? null };
        p.vessels.push(v); save(); return json(201, v);
      }
      const vessel = p.vessels.find((v) => v.id === id);
      if (!vessel) return fail(404, "NOT_FOUND", "No such vessel.");
      if (method === "PATCH") {
        const b = body() as Partial<Vessel>;
        if (b.name !== undefined) {
          const name = normName(b.name);
          if (p.vessels.some((v) => v.id !== vessel.id && v.name.toLowerCase() === name.toLowerCase())) return fail(409, "CONFLICT", `${name} is already registered.`);
          vessel.name = name;
        }
        if (b.lengthFt !== undefined && b.lengthFt !== vessel.lengthFt) {
          const newLen = Number(b.lengthFt);
          const broken = p.bookings.filter((x) => x.vesselId === vessel.id && x.status === "confirmed" &&
            (p.berths.find((be) => be.id === x.berthId)?.lengthFt ?? Infinity) < newLen);
          if (broken.length) return fail(409, "CONFLICT", `At ${newLen}′, ${vessel.name} would no longer fit ${broken.length} booked berth(s).`,
            [{ code: "VESSEL_TOO_LONG", severity: "error", message: `${broken.length} booking(s) would break.`, bookingIds: broken.map((x) => x.id) }]);
          vessel.lengthFt = newLen;
        }
        for (const k of ["draftFt", "operator", "notes"] as const) if (b[k] !== undefined) (vessel as unknown as Record<string, unknown>)[k] = b[k];
        save(); return json(200, vessel);
      }
      if (method === "DELETE") {
        const n = p.bookings.filter((x) => x.vesselId === vessel.id).length;
        if (n) return fail(409, "CONFLICT", `Used by ${n} booking${n === 1 ? "" : "s"} — can't delete.`);
        p.vessels = p.vessels.filter((v) => v.id !== vessel.id); save(); return json(204, null);
      }
    }

    // schedule
    if (res === "schedule" && method === "GET") {
      const from = q.get("from"), to = q.get("to");
      const bad = windowOk(from, to); if (bad) return fail(400, "VALIDATION", bad);
      const bookings = p.bookings.filter((b) => b.status === "confirmed" && b.startDate <= to! && b.endDate >= from!).map((b) => view(p, b));
      return json(200, { from, to, berths: sortedBerths(p), bookings });
    }

    // bookings
    if (res === "bookings") {
      if (id === "validate" && method === "POST") {
        const b = body() as unknown as BookingInput & { excludeBookingId?: string };
        const violations = validate(b, p, { source: "manual", asOfDate: settings.asOfDate, excludeId: b.excludeBookingId });
        return json(200, { ok: !violations.some((v) => v.severity === "error"), violations });
      }
      if (!id && method === "GET") {
        const from = q.get("from"), to = q.get("to");
        const bad = windowOk(from, to); if (bad) return fail(400, "VALIDATION", bad);
        const term = (q.get("q") ?? "").toLowerCase();
        const out = p.bookings
          .filter((b) => (q.get("includeCancelled") === "true" || b.status === "confirmed") && b.startDate <= to! && b.endDate >= from!)
          .map((b) => view(p, b))
          .filter((b) => (!q.get("berthId") || b.berthId === q.get("berthId")) && (!q.get("vesselId") || b.vesselId === q.get("vesselId"))
            && (!q.get("occupantType") || b.occupantType === q.get("occupantType")) && (!term || b.title.toLowerCase().includes(term)))
          .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.berthName.localeCompare(b.berthName)));
        return json(200, out);
      }
      if (!id && method === "POST") {
        const b = body() as unknown as BookingInput;
        const violations = validate(b, p, { source: "manual", asOfDate: settings.asOfDate });
        const r = rulesResponse(violations); if (r) return r;
        const vessel = b.vesselId ? p.vessels.find((v) => v.id === b.vesselId) : undefined;
        const booking: Booking = {
          id: newId(), berthId: b.berthId, occupantType: b.occupantType, vesselId: b.occupantType === "vessel" ? b.vesselId ?? null : null,
          title: b.occupantType === "vessel" ? vessel?.name ?? "" : String(b.title).trim(), startDate: b.startDate, endDate: b.endDate,
          status: "confirmed", notes: b.notes ?? null, source: "manual", version: 1, createdAt: nowTs(), updatedAt: nowTs(),
        };
        p.bookings.push(booking); save(); return json(201, view(p, booking));
      }
      const booking = p.bookings.find((b) => b.id === id);
      if (!booking) return fail(404, "NOT_FOUND", "This booking no longer exists.");
      if (!sub && method === "GET") return json(200, view(p, booking));
      if (!sub && method === "PATCH") {
        const b = body() as Partial<BookingInput> & { expectedVersion?: number };
        if (b.expectedVersion !== booking.version) return fail(409, "STALE_VERSION", "This booking changed since you opened it.");
        const merged: BookingInput = {
          berthId: b.berthId ?? booking.berthId, occupantType: b.occupantType ?? booking.occupantType,
          vesselId: b.vesselId !== undefined ? b.vesselId : booking.vesselId, title: b.title !== undefined ? b.title : booking.title,
          startDate: b.startDate ?? booking.startDate, endDate: b.endDate ?? booking.endDate, notes: b.notes !== undefined ? b.notes : booking.notes,
        };
        const violations = validate(merged, p, { source: "manual", asOfDate: settings.asOfDate, excludeId: booking.id });
        const r = rulesResponse(violations); if (r) return r;
        const vessel = merged.vesselId ? p.vessels.find((v) => v.id === merged.vesselId) : undefined;
        Object.assign(booking, {
          berthId: merged.berthId, occupantType: merged.occupantType, vesselId: merged.occupantType === "vessel" ? merged.vesselId : null,
          title: merged.occupantType === "vessel" ? vessel?.name ?? "" : String(merged.title ?? "").trim(),
          startDate: merged.startDate, endDate: merged.endDate, notes: merged.notes ?? null, version: booking.version + 1, updatedAt: nowTs(),
        });
        save(); return json(200, view(p, booking));
      }
      if (sub === "cancel" && method === "POST") {
        if (body().expectedVersion !== booking.version) return fail(409, "STALE_VERSION", "This booking changed since you opened it.");
        booking.status = "cancelled"; booking.version += 1; booking.updatedAt = nowTs(); save();
        return json(200, view(p, booking));
      }
    }

    // availability
    if (res === "availability" && method === "GET") {
      const s = q.get("startDate"), e = q.get("endDate");
      if (!isISODate(s) || !isISODate(e) || e < s) return fail(400, "VALIDATION", "startDate and endDate must be dates with start ≤ end.");
      let lengthFt: number | null = q.get("lengthFt") ? Number(q.get("lengthFt")) : null;
      if (q.get("vesselId")) {
        const v = p.vessels.find((x) => x.id === q.get("vesselId"));
        if (!v) return fail(404, "NOT_FOUND", "No such vessel.");
        if (v.lengthFt == null && lengthFt == null) return fail(422, "UNPROCESSABLE", `${v.name} has no length on record — give a length instead.`);
        lengthFt = v.lengthFt ?? lengthFt;
      }
      const options: AvailabilityOption[] = sortedBerths(p).filter((b) => b.active).map((berth) => {
        const conflicts = berth.kind === "berth"
          ? p.bookings.filter((b) => b.berthId === berth.id && b.status === "confirmed" && b.startDate <= e && s <= b.endDate)
              .map((b) => ({ bookingId: b.id, title: view(p, b).title, startDate: b.startDate, endDate: b.endDate }))
          : [];
        const fits = lengthFt == null || berth.kind === "section" || (berth.lengthFt ?? 0) >= lengthFt;
        const slackFt = lengthFt != null && berth.lengthFt != null ? berth.lengthFt - lengthFt : null;
        return { berth, free: berth.kind === "section" || conflicts.length === 0, fits, slackFt, conflicts };
      }).sort((a, b) => {
        const ga = a.free && a.fits ? 0 : 1, gb = b.free && b.fits ? 0 : 1;
        if (ga !== gb) return ga - gb;
        if (a.slackFt == null && b.slackFt != null) return 1;
        if (b.slackFt == null && a.slackFt != null) return -1;
        if (a.slackFt != null && b.slackFt != null && a.slackFt !== b.slackFt) return a.slackFt - b.slackFt;
        return a.berth.sortOrder - b.berth.sortOrder;
      });
      return json(200, { startDate: s, endDate: e, lengthFt, options });
    }

    // imports
    if (res === "imports") {
      if (!id && method === "POST") {
        const fd = init.body instanceof FormData ? init.body : null;
        const file = fd?.get("file");
        if (!(file instanceof File)) return fail(400, "VALIDATION", "Attach an .xlsx file.");
        const planTo = fd?.get("planTo");
        const imp = fakeImport(p, file, typeof planTo === "string" ? planTo : undefined);
        p.imports.unshift(imp); save();
        return json(201, imp.run);
      }
      if (!id && method === "GET") return json(200, p.imports.map((i) => i.run));
      const imp = p.imports.find((i) => i.run.id === id);
      if (!imp) return fail(404, "NOT_FOUND", "No such import.");
      if (!sub && method === "GET") return json(200, imp.run);
      if (!sub && method === "DELETE") {
        if (imp.run.status !== "previewed") return fail(409, "CONFLICT", "Only a previewed import can be discarded.");
        imp.run.status = "discarded"; save(); return json(204, null);
      }
      if (sub === "commit" && method === "POST") {
        if (imp.run.status !== "previewed") return fail(409, "CONFLICT", "This import was already committed or discarded.");
        for (const row of imp.staged) {
          const vessel = row.vesselName ? findOrCreateVessel(p, row.vesselName, row.vesselLengthFt) : undefined;
          const input: BookingInput = { berthId: row.berthId, occupantType: row.occupantType, vesselId: vessel?.id ?? null, title: vessel ? null : row.title, startDate: row.startDate, endDate: row.endDate };
          if (validate(input, p, { source: "import", asOfDate: settings.asOfDate }).some((v) => v.severity === "error")) continue;
          p.bookings.push({ id: newId(), berthId: row.berthId, occupantType: row.occupantType, vesselId: vessel?.id ?? null, title: vessel?.name ?? row.title,
            startDate: row.startDate, endDate: row.endDate, status: "confirmed", notes: null, source: "import", version: 1, createdAt: nowTs(), updatedAt: nowTs() });
        }
        p.conflicts = [...(p.conflicts ?? []), ...(imp.conflicts ?? []).map((c) => openConflict(p, c, imp.run.id))];
        imp.run.status = "committed"; imp.run.committedAt = nowTs(); save();
        return json(200, imp.run);
      }
      if (sub === "issues" && !subId && method === "GET") {
        const limit = Number(q.get("limit") ?? 50), cursor = Number(q.get("cursor") ?? 0);
        const list = imp.issues.filter((i) => (!q.get("severity") || i.severity === q.get("severity")) && (!q.get("code") || i.code === q.get("code"))
          && (q.get("resolved") == null || String(i.resolved) === q.get("resolved")));
        const items = list.slice(cursor, cursor + limit);
        return json(200, { items, nextCursor: cursor + limit < list.length ? String(cursor + limit) : null });
      }
      if (sub === "issues" && subId && action === "resolve" && method === "POST") {
        const issue = imp.issues.find((i) => i.id === subId);
        if (!issue) return fail(404, "NOT_FOUND", "No such issue.");
        const b = body() as { action?: string; berthId?: string; vesselLengthFt?: number; reason?: string };
        if (b.action === "dismiss") { issue.resolved = true; issue.resolution = "dismissed"; save(); return json(200, issue); }
        if (b.action === "create_booking" && issue.row && b.berthId) {
          const row = issue.row;
          const vessel = row.occupantType === "vessel" ? findOrCreateVessel(p, row.title, b.vesselLengthFt ?? row.vesselLengthFt) : undefined;
          if (vessel && b.vesselLengthFt != null && vessel.lengthFt == null) vessel.lengthFt = b.vesselLengthFt;
          const input: BookingInput = { berthId: b.berthId, occupantType: row.occupantType, vesselId: vessel?.id ?? null, title: vessel ? null : row.title, startDate: row.startDate, endDate: row.endDate };
          const r = rulesResponse(validate(input, p, { source: "import", asOfDate: settings.asOfDate })); if (r) return r;
          p.bookings.push({ id: newId(), berthId: b.berthId, occupantType: row.occupantType, vesselId: vessel?.id ?? null, title: vessel?.name ?? row.title,
            startDate: row.startDate, endDate: row.endDate, status: "confirmed", notes: null, source: "import", version: 1, createdAt: nowTs(), updatedAt: nowTs() });
          issue.resolved = true; issue.resolution = "created"; save();
          return json(200, issue);
        }
        return fail(400, "VALIDATION", "Resolve needs action dismiss, or create_booking with a berthId on an issue that has a row.");
      }
    }

    // conflicts
    if (res === "conflicts") {
      const all = (p.conflicts ??= []);
      if (id === "summary" && method === "GET") {
        const open = all.filter((c) => c.status === "open");
        const byType = Object.fromEntries(CONFLICT_TYPES.map((t) => [t, open.filter((c) => c.type === t).length])) as ConflictSummary["byType"];
        const berthCounts = new Map<string | null, number>();
        for (const c of open) berthCounts.set(c.berthId, (berthCounts.get(c.berthId) ?? 0) + 1);
        const byBerth = [...berthCounts].map(([berthId, n]) => ({ berthId, berthName: p.berths.find((b) => b.id === berthId)?.name ?? null, open: n }))
          .sort((a, b) => b.open - a.open);
        const n = (s: Conflict["status"]) => all.filter((c) => c.status === s).length;
        return json(200, { open: n("open"), placed: n("placed"), dismissed: n("dismissed"), byType, byBerth } satisfies ConflictSummary);
      }
      if (!id && method === "GET") {
        const limit = Number(q.get("limit") ?? 50), cursor = Number(q.get("cursor") ?? 0);
        const term = (q.get("q") ?? "").toLowerCase();
        const list = all.filter((c) => c.status === (q.get("status") ?? "open") && (!q.get("type") || c.type === q.get("type"))
            && (!q.get("berthId") || c.berthId === q.get("berthId")) && (!term || c.title.toLowerCase().includes(term)))
          .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
        return json(200, { items: list.slice(cursor, cursor + limit).map((c) => conflictOut(p, c)),
          nextCursor: cursor + limit < list.length ? String(cursor + limit) : null });
      }
      if (id === "dismiss" && method === "POST") {
        const b = body() as { ids?: string[]; type?: ConflictType; reason?: string };
        if (!b.ids === !b.type) return fail(400, "VALIDATION", "Give either ids or a type.");
        let n = 0;
        for (const c of all) if (c.status === "open" && (b.ids ? b.ids.includes(c.id) : c.type === b.type)) {
          c.status = "dismissed"; c.resolutionNote = b.reason?.trim() || null; c.resolvedAt = nowTs(); n++;
        }
        save(); return json(200, { dismissed: n });
      }
      const c = all.find((x) => x.id === id);
      if (!c) return fail(404, "NOT_FOUND", "No such conflict.");
      if (sub === "resolve" && method === "POST") {
        if (c.status !== "open") return fail(409, "CONFLICT", `This conflict is already ${c.status}.`);
        const b = body() as { action?: string; berthId?: string; startDate?: string; endDate?: string; vesselLengthFt?: number; reason?: string };
        if (b.action === "dismiss") {
          c.status = "dismissed"; c.resolutionNote = b.reason?.trim() || null; c.resolvedAt = nowTs(); save();
          return json(200, conflictOut(p, c));
        }
        if (b.action === "place" && b.berthId) {
          const vessel = c.occupantType === "vessel" ? findOrCreateVessel(p, c.title, b.vesselLengthFt ?? null) : undefined;
          const input: BookingInput = { berthId: b.berthId, occupantType: c.occupantType, vesselId: vessel?.id ?? null, title: vessel ? null : c.title,
            startDate: b.startDate ?? c.startDate, endDate: b.endDate ?? c.endDate };
          const r = rulesResponse(validate(input, p, { source: "import", asOfDate: settings.asOfDate })); if (r) return r;
          const booking: Booking = { id: newId(), berthId: b.berthId, occupantType: c.occupantType, vesselId: vessel?.id ?? null, title: vessel?.name ?? c.title,
            startDate: input.startDate, endDate: input.endDate, status: "confirmed", notes: null, source: "import", version: 1, createdAt: nowTs(), updatedAt: nowTs() };
          p.bookings.push(booking);
          c.status = "placed"; c.bookingId = booking.id; c.bookingIds = [booking.id]; c.resolvedAt = nowTs(); save();
          return json(200, conflictOut(p, c));
        }
        return fail(400, "VALIDATION", "Resolve needs action dismiss, or place with a berthId.");
      }
    }

    // audit
    if (res === "audit" && method === "GET") {
      const confirmed = p.bookings.filter((b) => b.status === "confirmed");
      const violations: AuditReport["violations"] = [];
      const summary: AuditReport["summary"] = {};
      for (const b of confirmed) {
        const vs = validate({ berthId: b.berthId, occupantType: b.occupantType, vesselId: b.vesselId, title: b.title, startDate: b.startDate, endDate: b.endDate },
          p, { source: "import", asOfDate: settings.asOfDate, excludeId: b.id }).filter((v) => v.severity === "error" && v.code !== "BERTH_INACTIVE");
        if (vs.length) { violations.push({ bookingId: b.id, violations: vs }); for (const v of vs) summary[v.code] = (summary[v.code] ?? 0) + 1; }
      }
      return json(200, { generatedAt: nowTs(), checkedBookings: confirmed.length, violations, summary } satisfies AuditReport);
    }
  } catch (e) {
    if (e instanceof UnknownEntity) return fail(404, "NOT_FOUND", e.message);
    throw e;
  }
  return fail(404, "NOT_FOUND", `No mock for ${method} ${u.pathname}`);
}
