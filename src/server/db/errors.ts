/**
 * Postgres error → ApiErr, by constraint name (database.md §4), never by message text.
 * Reaching a rule constraint here means rules.ts missed something: map it AND log it loudly.
 */
import type { ViolationCode } from "@shared/contract";
import { ApiErr } from "../http/api-error";

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

const RULES: Record<string, { code: ViolationCode; message: string }> = {
  booking_no_overlap: { code: "OVERLAP", message: "That berth is already booked on some of those days." },
  booking_vessel_once: { code: "VESSEL_DOUBLE_BERTHED", message: "That vessel is already booked elsewhere on some of those days." },
  booking_fit: { code: "VESSEL_TOO_LONG", message: "The vessel is longer than the berth." },
  vessel_length_guard: { code: "VESSEL_TOO_LONG", message: "That length would make the vessel too long for a berth it is booked on." },
  berth_length_guard: { code: "VESSEL_TOO_LONG", message: "That length is shorter than a vessel booked on this berth." },
  booking_range_valid: { code: "INVALID_RANGE", message: "End date is before start date." },
};

export function isPgError(e: unknown): e is PgError {
  return typeof e === "object" && e !== null && typeof (e as PgError).code === "string" && /^[0-9A-Z]{5}$/.test((e as PgError).code!);
}

export function fromPgError(e: unknown): ApiErr | null {
  if (!isPgError(e)) return null;
  const c = e.constraint ?? "";
  const rule = RULES[c];
  if (rule) {
    console.error(`[rules.ts missed a rule] DB constraint ${c} fired:`, e.message);
    const status = rule.code === "OVERLAP" || rule.code === "VESSEL_DOUBLE_BERTHED" ? "CONFLICT" : "UNPROCESSABLE";
    return new ApiErr(status, rule.message, [{ code: rule.code, severity: "error", message: rule.message }]);
  }
  if (e.code === "23505") {
    if (c === "berth_name_uq") return new ApiErr("CONFLICT", "A berth with that name already exists in this project.");
    if (c === "vessel_name_uq") return new ApiErr("CONFLICT", "A vessel with that name already exists in this project.");
    return new ApiErr("CONFLICT", "That already exists.");
  }
  if (e.code === "23503" && (c === "booking_berth_fk" || c === "booking_vessel_fk")) {
    return new ApiErr("CONFLICT", "It is still referenced by bookings.");
  }
  if (e.code === "23514" || e.code === "22007" || e.code === "22008") {
    return new ApiErr("UNPROCESSABLE", "A value was rejected by the database.");
  }
  return null;
}
