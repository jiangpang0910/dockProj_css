// The projects this browser remembers (infrastructure.md §5): ids and names in localStorage, nothing else.
"use client";
import { useSyncExternalStore } from "react";
import type { Project } from "@shared/contract";

const KEY = "dock.projects";
export interface RememberedProject { id: string; name: string }

let cache: RememberedProject[] | null = null;
const listeners = new Set<() => void>();

function read(): RememberedProject[] {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(KEY) ?? "[]") as RememberedProject[]; } catch { cache = []; }
  return cache;
}
function write(list: RememberedProject[]) {
  cache = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}
export function rememberProject(p: Pick<Project, "id" | "name">) {
  write([{ id: p.id, name: p.name }, ...read().filter((x) => x.id !== p.id)]);
}
export function forgetProjects(ids: string[]) {
  if (!ids.length) return;
  write(read().filter((x) => !ids.includes(x.id)));
}
const EMPTY: RememberedProject[] = [];
export function useRememberedProjects(): RememberedProject[] {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    read,
    () => EMPTY,
  );
}
