import type { LengthFilter } from "@shared/contract";
// query keys — every key starts with the project id, so switching projects can never show another project's
// cached data. Invalidate [pid, "schedule"] and [pid, "bookings"] after any booking mutation, commit, or resolve.
export const qk = {
  projects: () => ["projects"] as const,
  project: (pid: string) => ["project", pid] as const,
  schedule: (pid: string, from: string, to: string) => [pid, "schedule", from, to] as const,
  bookings: (pid: string, f: object) => [pid, "bookings", f] as const,
  booking: (pid: string, id: string) => [pid, "booking", id] as const,
  availability: (pid: string, q: object) => [pid, "availability", q] as const,
  vessels: (pid: string, q?: string, length?: LengthFilter) => [pid, "vessels", q ?? "", length ?? "all"] as const,
  berths: (pid: string, includeInactive = false) => [pid, "berths", includeInactive] as const,
  tours: (pid: string, f: object = {}) => [pid, "tours", f] as const,
  usage: (pid: string) => [pid, "usage"] as const,
  settings: (pid: string) => [pid, "settings"] as const,
  conflicts: (pid: string, f: object) => [pid, "conflicts", f] as const,
  conflictSummary: (pid: string, w: object = {}) => [pid, "conflicts", "summary", w] as const,
};
