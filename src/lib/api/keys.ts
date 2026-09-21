// query keys — every key starts with the project id, so switching projects can never show another project's
// cached data. Invalidate [pid, "schedule"] and [pid, "bookings"] after any booking mutation, commit, or resolve.
export const qk = {
  projects: (ids: string[]) => ["projects", ids] as const,
  project: (pid: string) => ["project", pid] as const,
  schedule: (pid: string, from: string, to: string) => [pid, "schedule", from, to] as const,
  bookings: (pid: string, f: object) => [pid, "bookings", f] as const,
  booking: (pid: string, id: string) => [pid, "booking", id] as const,
  availability: (pid: string, q: object) => [pid, "availability", q] as const,
  vessels: (pid: string, q?: string, lengthUnknown?: boolean) => [pid, "vessels", q ?? "", !!lengthUnknown] as const,
  berths: (pid: string, includeInactive = false) => [pid, "berths", includeInactive] as const,
  settings: (pid: string) => [pid, "settings"] as const,
  imports: (pid: string) => [pid, "imports"] as const,
  importRun: (pid: string, id: string) => [pid, "imports", id] as const,
  issues: (pid: string, id: string, f: object) => [pid, "imports", id, "issues", f] as const,
  audit: (pid: string) => [pid, "audit"] as const,
};
