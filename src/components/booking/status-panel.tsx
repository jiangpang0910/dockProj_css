"use client";
import { AlertTriangle, CheckCircle2, Loader2, OctagonX, Search } from "lucide-react";
import type { Berth, Vessel, Violation } from "@shared/contract";
import { Button } from "@/components/ui/button";
import { ft } from "@/lib/format";
import { FitBar } from "./fit-bar";

export type CheckState =
  | { kind: "idle"; missing: string[] }
  | { kind: "checking" }
  | { kind: "done"; violations: Violation[] }
  | { kind: "error"; message: string };

/**
 * The status panel under the booking form — the core interaction (frontend.md §3.2).
 * Says why, then what to do: every blocker is named, with links and a way to another berth.
 */
export function StatusPanel({
  state, vessel, berth, onOpenBooking, onFindBerth, lengthFixer,
}: {
  state: CheckState;
  vessel: Vessel | undefined;
  berth: Berth | undefined;
  onOpenBooking: (id: string) => void;
  onFindBerth: () => void;
  lengthFixer?: React.ReactNode;
}) {
  return (
    <div aria-live="polite" className="min-h-16 rounded-lg border bg-surface p-3 text-sm">
      {state.kind === "idle" && (
        <p className="text-ink-muted">
          {state.missing.length ? `Add ${state.missing.join(", ")} to check this booking.` : "Checking starts as soon as the form is complete."}
        </p>
      )}
      {state.kind === "checking" && (
        <p className="flex items-center gap-2 text-ink-muted"><Loader2 className="size-4 animate-spin" /> Checking the berth…</p>
      )}
      {state.kind === "error" && <p className="text-signal">{state.message}</p>}
      {state.kind === "done" && <Result violations={state.violations} vessel={vessel} berth={berth}
        onOpenBooking={onOpenBooking} onFindBerth={onFindBerth} lengthFixer={lengthFixer} />}
    </div>
  );
}

function Result({ violations, vessel, berth, onOpenBooking, onFindBerth, lengthFixer }: {
  violations: Violation[]; vessel: Vessel | undefined; berth: Berth | undefined;
  onOpenBooking: (id: string) => void; onFindBerth: () => void; lengthFixer?: React.ReactNode;
}) {
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");
  const canFit = vessel?.lengthFt != null && berth?.lengthFt != null && berth.kind === "berth";
  const blockedBySchedule = errors.some((e) => ["OVERLAP", "VESSEL_TOO_LONG", "BERTH_INACTIVE"].includes(e.code));

  return (
    <div className="space-y-3">
      {errors.length === 0 && (
        <div className="flex items-start gap-2 text-ok">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <div className="font-medium">
            {canFit
              ? <>Fits with <span className="num">{ft(berth!.lengthFt! - vessel!.lengthFt!)}</span> to spare · berth free</>
              : berth?.kind === "section" ? "Shared section — no overlap or length limits" : "Berth free for these days"}
          </div>
        </div>
      )}
      {errors.length === 0 && canFit && <FitBar vesselFt={vessel!.lengthFt!} berthFt={berth!.lengthFt!} />}

      {errors.map((v, i) => (
        <div key={`e${i}`} className="space-y-2 rounded-md border border-signal/40 bg-signal-soft p-2.5">
          <div className="flex items-start gap-2 text-signal">
            <OctagonX className="mt-0.5 size-4 shrink-0" />
            <div>
              <span className="mr-1.5 rounded bg-signal/10 px-1 py-px font-mono text-[10px] font-semibold tracking-wide">{v.code}</span>
              <span className="text-ink">{v.message}</span>
            </div>
          </div>
          {v.code === "VESSEL_TOO_LONG" && v.details?.vesselLengthFt != null && v.details.berthLengthFt != null && (
            <FitBar vesselFt={v.details.vesselLengthFt} berthFt={v.details.berthLengthFt} />
          )}
          {v.bookingIds && v.bookingIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pl-6">
              {v.bookingIds.slice(0, 6).map((id, n) => (
                <button key={id} type="button" onClick={() => onOpenBooking(id)}
                  className="rounded border border-signal/40 bg-surface px-1.5 py-0.5 text-xs text-ink hover:border-signal">
                  View blocking booking{v.bookingIds!.length > 1 ? ` ${n + 1}` : ""} →
                </button>
              ))}
            </div>
          )}
          {v.code === "VESSEL_LENGTH_UNKNOWN" && lengthFixer && <div className="pl-6">{lengthFixer}</div>}
        </div>
      ))}

      {warnings.map((v, i) => (
        <div key={`w${i}`} className="flex items-start gap-2 text-brass">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="text-ink"><span className="mr-1.5 font-mono text-[10px] font-semibold text-brass">{v.code}</span>{v.message}</span>
        </div>
      ))}

      {blockedBySchedule && (
        <Button type="button" variant="outline" size="sm" onClick={onFindBerth}>
          <Search /> Find another berth
        </Button>
      )}
    </div>
  );
}
