/** Row (snake_case, from SQL) → contract type (camelCase). One place, so every endpoint returns the same shapes. */
import type { Berth, BookingView, ISODateTime, Vessel } from "@shared/contract";

type Row = Record<string, unknown>;

export function isoTime(v: unknown): ISODateTime {
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

export function toBerth(r: Row): Berth {
  return {
    id: r.id as string,
    name: r.name as string,
    lengthFt: num(r.length_ft),
    active: r.active as boolean,
    sortOrder: r.sort_order as number,
  };
}

export function toVessel(r: Row): Vessel {
  return {
    id: r.id as string,
    name: r.name as string,
    lengthFt: num(r.length_ft),
    draftFt: num(r.draft_ft),
    operator: (r.operator as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
  };
}

/** From a booking_view row. */
export function toBookingView(r: Row): BookingView {
  return {
    id: r.id as string,
    berthId: r.berth_id as string,
    occupantType: r.occupant_type as BookingView["occupantType"],
    vesselId: (r.vessel_id as string | null) ?? null,
    title: r.display_title as string,
    startDate: r.start_date as string,
    endDate: r.end_date as string,
    status: r.status as BookingView["status"],
    notes: (r.notes as string | null) ?? null,
    source: r.source as BookingView["source"],
    version: r.version as number,
    createdAt: isoTime(r.created_at),
    updatedAt: isoTime(r.updated_at),
    berthName: r.berth_name as string,
    vesselLengthFt: num(r.vessel_length_ft),
    berthLengthFt: num(r.berth_length_ft),
  };
}

/** Names are stored normalised: trimmed, single spaces, the "OS/V" prefix typo fixed. */
export function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, " ").replace(/^OS\/V\s/i, "OSV ");
}
