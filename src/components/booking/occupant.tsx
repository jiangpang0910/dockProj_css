import { Construction, Flag, Ship } from "lucide-react";
import type { OccupantType } from "@shared/contract";
import { cn } from "@/lib/utils";

/** Meaning is never color alone: every bar and badge also carries this icon (frontend.md §2). */
export function OccupantIcon({ type, className }: { type: OccupantType; className?: string }) {
  const C = type === "vessel" ? Ship : type === "event" ? Flag : Construction;
  return <C aria-hidden className={cn("size-3.5 shrink-0", className)} />;
}

/** Bar/chip styling per occupant type. */
export const occupantStyle: Record<OccupantType, string> = {
  vessel: "bg-harbor-soft text-ink border-harbor/45 [--bar-edge:var(--harbor)]",
  event: "bg-brass-soft text-ink border-brass/50 [--bar-edge:var(--brass)]",
  closure: "hatch text-ink border-ink-muted/50 [--bar-edge:var(--ink-muted)]",
};
