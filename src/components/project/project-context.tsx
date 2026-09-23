"use client";
// Everything scoped to the open project: its id, its API, and the shared reference data (settings, berths, vessels).
import { createContext, useContext, useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { Berth, LengthFilter, Settings, Vessel } from "@shared/contract";
import { getProject, inProject, type ProjectApi } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/keys";
import { addDays, addYears, startOfMonth } from "@/lib/dates";

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

/**
 * The window the Conflicts screen is showing — read here rather than on the screen, because the count on the rail
 * has to agree with the count on the page. Its defaults are the Events screen's: this month, plus twelve, from the
 * project's "today". The screen writes ?from/?to/?all into the URL; anywhere else those params belong to another
 * screen, so only the defaults are used.
 */
export function useConflictWindow(): { from?: string; to?: string; windowed: boolean; allDates: boolean; ready: boolean } {
  const today = useToday();
  const params = useSearchParams();
  const pathname = usePathname();
  const onScreen = pathname.endsWith("/conflicts");
  const allDates = onScreen && params.get("all") === "1";
  const defFrom = today ? startOfMonth(today) : "";
  const defTo = defFrom ? addDays(addYears(defFrom, 1), -1) : "";
  const from = allDates ? undefined : ((onScreen ? params.get("from") : null) ?? defFrom) || undefined;
  const to = allDates ? undefined : ((onScreen ? params.get("to") : null) ?? defTo) || undefined;
  return { from, to, windowed: !allDates && !!(from && to), allDates, ready: allDates || !!from };
}

export function useBerths(includeInactive = false) {
  const { pid, api } = useProjectCtx();
  return useQuery<Berth[]>({ queryKey: qk.berths(pid, includeInactive), queryFn: () => api.listBerths(includeInactive), staleTime: 60_000 });
}

export function useVessels(q?: string, length?: LengthFilter) {
  const { pid, api } = useProjectCtx();
  return useQuery<Vessel[]>({
    queryKey: qk.vessels(pid, q, length),
    queryFn: () => api.listVessels(q, length),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}
