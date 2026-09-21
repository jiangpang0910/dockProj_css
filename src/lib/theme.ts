// Light / dark / follow the system. The choice lives in localStorage; the .dark class on <html> drives the look.
// layout.tsx runs the same logic inline before first paint so there's no flash.
"use client";
import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
export const THEME_KEY = "dock.theme";

const listeners = new Set<() => void>();

function read(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch { return "system"; }
}

export function applyTheme(pref: ThemePref = read()) {
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function setTheme(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, pref);
  } catch { /* private mode: still switch for this page view */ }
  applyTheme(pref);
  listeners.forEach((l) => l());
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    read,
    () => "system",
  );
}
