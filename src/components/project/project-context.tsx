"use client";
// Everything scoped to the open project: its id, its API, and the shared reference data (settings, berths, vessels).
import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Berth, Settings, Vessel } from "@shared/contract";
import { getProject, inProject, type ProjectApi } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/keys";

interface Ctx { pid: string; api: ProjectApi }
const ProjectCtx = createContext<Ctx | null>(null);

export function ProjectProvider({ pid, children }: { pid: string; children: React.ReactNode }) {
  const value = useMemo(() => ({ pid, api: inProject(pid) }), [pid]);
  return <ProjectCtx.Provider value={value}>{children}</ProjectCtx.Provider>;
}

export function useProjectCtx(): Ctx {
  const c = useContext(ProjectCtx);
  if (!c) throw new Error("useProjectCtx outside ProjectProvider");
  return c;
}

export function useProject() {
  const { pid } = useProjectCtx();
  return useQuery({ queryKey: qk.project(pid), queryFn: () => getProject(pid), staleTime: 60_000 });
}

export function useSettings() {
  const { pid, api } = useProjectCtx();
  return useQuery<Settings>({ queryKey: qk.settings(pid), queryFn: () => api.getSettings(), staleTime: 60_000 });
}

/** The project's "today" (settings.asOfDate), or undefined while loading. */
export function useToday(): string | undefined {
  return useSettings().data?.asOfDate;
}

export function useBerths(includeInactive = false) {
  const { pid, api } = useProjectCtx();
  return useQuery<Berth[]>({ queryKey: qk.berths(pid, includeInactive), queryFn: () => api.listBerths(includeInactive), staleTime: 60_000 });
}

export function useVessels(q?: string, lengthUnknown?: boolean) {
  const { pid, api } = useProjectCtx();
  return useQuery<Vessel[]>({
    queryKey: qk.vessels(pid, q, lengthUnknown),
    queryFn: () => api.listVessels(q, lengthUnknown),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}
