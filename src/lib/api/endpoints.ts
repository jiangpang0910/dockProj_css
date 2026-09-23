// src/lib/api/endpoints.ts — one function per endpoint (frontend.md §7.2); components never call fetch directly.
import type * as T from "@shared/contract";
import { api, qs } from "./client";

export const health        = () => api<{ ok: true }>("/health");
export const listProjects  = () => api<T.Project[]>("/projects");
export const createProject = (body: T.ProjectInput) => api<T.Project>("/projects", { method: "POST", json: body });
export const getProject    = (pid: T.Id) => api<T.Project>(`/projects/${pid}`);
export const renameProject = (pid: T.Id, body: T.ProjectPatch) => api<T.Project>(`/projects/${pid}`, { method: "PATCH", json: body });
export const deleteProject = (pid: T.Id) => api<void>(`/projects/${pid}`, { method: "DELETE" });

export type BookingsFilter = {
  from: T.ISODate; to: T.ISODate; berthId?: T.Id; vesselId?: T.Id;
  occupantType?: T.OccupantType; q?: string; includeCancelled?: boolean;
};
export type ConflictsFilter = { type?: T.ConflictType; status?: T.ConflictStatus; berthId?: T.Id; q?: string;
  from?: T.ISODate; to?: T.ISODate; cursor?: string; limit?: number };

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

    listVessels:   (q?: string, length?: T.LengthFilter) => api<T.Vessel[]>(`${P}/vessels?${qs({ q, length })}`),

    listTours:     (f: { from?: T.ISODate; to?: T.ISODate; q?: string } = {}) => api<T.Tour[]>(`${P}/tours?${qs(f)}`),
    createTour:    (body: T.TourInput) => api<T.Tour>(`${P}/tours`, { method: "POST", json: body }),
    updateTour:    (id: T.Id, body: Partial<T.TourInput>) => api<T.Tour>(`${P}/tours/${id}`, { method: "PATCH", json: body }),
    deleteTour:    (id: T.Id) => api<void>(`${P}/tours/${id}`, { method: "DELETE" }),
    berthUsage:    () => api<T.BerthUsage[]>(`${P}/usage`),
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

    listConflicts:    (f: ConflictsFilter) => api<T.Page<T.Conflict>>(`${P}/conflicts?${qs(f)}`),
    conflictSummary:  (w: { from?: T.ISODate; to?: T.ISODate } = {}) => api<T.ConflictSummary>(`${P}/conflicts/summary?${qs(w)}`),
    resolveConflict:  (id: T.Id, body: T.ResolveConflictInput) =>
      api<T.Conflict>(`${P}/conflicts/${id}/resolve`, { method: "POST", json: body }),
    dismissConflicts: (body: T.DismissConflictsInput) =>
      api<{ dismissed: number }>(`${P}/conflicts/dismiss`, { method: "POST", json: body }),
    solveConflicts:   (body: T.SolveRequest) => api<T.SolveResult>(`${P}/conflicts/solve`, { method: "POST", json: body }),
    applyProposals:   (body: T.ApplyProposalsInput) =>
      api<T.ApplyProposalsResult>(`${P}/conflicts/apply`, { method: "POST", json: body }),

  };
};
export type ProjectApi = ReturnType<typeof inProject>;
