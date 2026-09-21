// src/lib/api/endpoints.ts — one function per endpoint (frontend.md §7.2); components never call fetch directly.
import type * as T from "@shared/contract";
import { api, qs } from "./client";

export const health        = () => api<{ ok: true }>("/health");
export const listProjects  = (ids: T.Id[]) => api<T.Project[]>(`/projects?${qs({ ids: ids.join(",") })}`);
export const createProject = (body: T.ProjectInput) => api<T.Project>("/projects", { method: "POST", json: body });
export const getProject    = (pid: T.Id) => api<T.Project>(`/projects/${pid}`);
export const renameProject = (pid: T.Id, body: T.ProjectPatch) => api<T.Project>(`/projects/${pid}`, { method: "PATCH", json: body });
export const deleteProject = (pid: T.Id) => api<void>(`/projects/${pid}`, { method: "DELETE" });

export type BookingsFilter = {
  from: T.ISODate; to: T.ISODate; berthId?: T.Id; vesselId?: T.Id;
  occupantType?: T.OccupantType; q?: string; includeCancelled?: boolean;
};
export type IssuesFilter = { severity?: "error" | "warning" | "info"; code?: string; resolved?: boolean; cursor?: string; limit?: number };

// everything else is scoped: const p = inProject(pid); p.getSchedule(from, to)
export const inProject = (pid: T.Id) => {
  const P = `/projects/${pid}`;
  return {
    getSettings:   () => api<T.Settings>(`${P}/settings`),
    putSettings:   (body: T.SettingsPatch) => api<T.Settings>(`${P}/settings`, { method: "PUT", json: body }),

    listBerths:    (includeInactive = false) => api<T.Berth[]>(`${P}/berths?${qs({ includeInactive: includeInactive || undefined })}`),
    createBerth:   (body: T.BerthInput) => api<T.Berth>(`${P}/berths`, { method: "POST", json: body }),
    updateBerth:   (id: T.Id, body: T.BerthPatch) => api<T.Berth>(`${P}/berths/${id}`, { method: "PATCH", json: body }),
    deleteBerth:   (id: T.Id) => api<void>(`${P}/berths/${id}`, { method: "DELETE" }),

    listVessels:   (q?: string, lengthUnknown?: boolean) => api<T.Vessel[]>(`${P}/vessels?${qs({ q, lengthUnknown: lengthUnknown || undefined })}`),
    createVessel:  (body: T.VesselInput) => api<T.Vessel>(`${P}/vessels`, { method: "POST", json: body }),
    updateVessel:  (id: T.Id, body: Partial<T.VesselInput>) => api<T.Vessel>(`${P}/vessels/${id}`, { method: "PATCH", json: body }),
    deleteVessel:  (id: T.Id) => api<void>(`${P}/vessels/${id}`, { method: "DELETE" }),

    getSchedule:   (from: T.ISODate, to: T.ISODate) => api<T.ScheduleResponse>(`${P}/schedule?${qs({ from, to })}`),
    listBookings:  (f: BookingsFilter) => api<T.BookingView[]>(`${P}/bookings?${qs(f)}`),
    getBooking:    (id: T.Id) => api<T.BookingView>(`${P}/bookings/${id}`),
    validate:      (body: T.ValidateRequest, signal?: AbortSignal) =>
      api<T.ValidationResult>(`${P}/bookings/validate`, { method: "POST", json: body, signal }),
    createBooking: (body: T.BookingInput) => api<T.BookingView>(`${P}/bookings`, { method: "POST", json: body }),
    updateBooking: (id: T.Id, body: T.BookingPatch) => api<T.BookingView>(`${P}/bookings/${id}`, { method: "PATCH", json: body }),
    cancelBooking: (id: T.Id, expectedVersion: number) =>
      api<T.BookingView>(`${P}/bookings/${id}/cancel`, { method: "POST", json: { expectedVersion } }),

    availability:  (q: { startDate: T.ISODate; endDate: T.ISODate; vesselId?: T.Id; lengthFt?: number }) =>
      api<T.AvailabilityResult>(`${P}/availability?${qs(q)}`),

    uploadImport:  (file: File, planTo?: T.ISODate) => {
      const f = new FormData();
      f.append("file", file);
      if (planTo) f.append("planTo", planTo);
      return api<T.ImportRun>(`${P}/imports`, { method: "POST", body: f });
    },
    listImports:   () => api<T.ImportRun[]>(`${P}/imports`),
    getImport:     (id: T.Id) => api<T.ImportRun>(`${P}/imports/${id}`),
    listIssues:    (id: T.Id, f: IssuesFilter) => api<T.Page<T.ImportIssue>>(`${P}/imports/${id}/issues?${qs(f)}`),
    commitImport:  (id: T.Id) => api<T.ImportRun>(`${P}/imports/${id}/commit`, { method: "POST" }),
    discardImport: (id: T.Id) => api<void>(`${P}/imports/${id}`, { method: "DELETE" }),
    resolveIssue:  (id: T.Id, issueId: T.Id, body: T.ResolveIssueInput) =>
      api<T.ImportIssue>(`${P}/imports/${id}/issues/${issueId}/resolve`, { method: "POST", json: body }),

    audit:         () => api<T.AuditReport>(`${P}/audit`),
  };
};
export type ProjectApi = ReturnType<typeof inProject>;
