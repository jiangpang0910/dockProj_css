import { ft } from "@/lib/format";

/**
 * Vessel length drawn against berth length. Overflow is the only part in the conflict colour.
 * Used in the booking form's status panel and the booking drawer.
 */
export function FitBar({ vesselFt, berthFt, compact = false }: { vesselFt: number; berthFt: number; compact?: boolean }) {
  const scale = Math.max(vesselFt, berthFt);
  const fits = vesselFt <= berthFt;
  const berthPct = (berthFt / scale) * 100;
  const vesselPct = (Math.min(vesselFt, berthFt) / scale) * 100;
  const overPct = fits ? 0 : ((vesselFt - berthFt) / scale) * 100;
  const diff = Math.abs(berthFt - vesselFt);
  return (
    <figure className="w-full" aria-label={fits ? `Vessel ${ft(vesselFt)} fits berth ${ft(berthFt)} with ${ft(diff)} to spare` : `Vessel ${ft(vesselFt)} is ${ft(diff)} longer than berth ${ft(berthFt)}`}>
      <div className="relative h-5 w-full">
        {/* the berth: a quay edge */}
        <div className="absolute inset-y-1 left-0 rounded-sm border border-dashed border-ink-muted/60 bg-surface" style={{ width: `${berthPct}%` }} />
        {/* the vessel */}
        <div className="absolute inset-y-0 left-0 rounded-sm bg-harbor/80" style={{ width: `${vesselPct}%` }} />
        {overPct > 0 && (
          <div className="absolute inset-y-0 rounded-r-sm bg-signal" style={{ left: `${berthPct}%`, width: `${overPct}%` }} />
        )}
      </div>
      {!compact && (
        <figcaption className="mt-1 flex justify-between text-xs text-ink-muted">
          <span className="num">vessel {ft(vesselFt)} · berth {ft(berthFt)}</span>
          <span className={`num font-medium ${fits ? "text-ok" : "text-signal"}`}>{fits ? `${ft(diff)} to spare` : `short by ${ft(diff)}`}</span>
        </figcaption>
      )}
    </figure>
  );
}
