"use client";
import { Monitor, Moon, Sun } from "lucide-react";
import { setTheme, useThemePref, type ThemePref } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemePref; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "Match system", Icon: Monitor },
];

export function ThemeToggle({ className }: { className?: string }) {
  const pref = useThemePref();
  return (
    <div role="radiogroup" aria-label="Theme" className={cn("inline-flex h-7 shrink-0 items-center rounded-full border bg-surface p-0.5", className)}>
      {OPTIONS.map(({ value, label, Icon }) => (
        <button key={value} type="button" role="radio" aria-checked={pref === value} aria-label={label} title={label}
          onClick={() => setTheme(value)}
          className={cn("grid size-6 place-items-center rounded-full transition-colors",
            pref === value ? "bg-harbor-soft text-ink" : "text-ink-muted hover:text-ink")}>
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
