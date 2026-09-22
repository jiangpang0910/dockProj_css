"use client";
// The workbook's own "8 YR Dock Usage" figures (days per berth per year), shown as they were written. Reference
// only: the schedule is the source of truth for what is booked now.
import { useQuery } from "@tanstack/react-query";
import { qk } from "@/lib/api/keys";
import { useProjectCtx } from "@/components/project/project-context";

export function UsageTable() {
  const { pid, api } = useProjectCtx();
  const usage = useQuery({ queryKey: qk.usage(pid), queryFn: () => api.berthUsage(), staleTime: 300_000 });
  const rows = usage.data ?? [];
  if (!rows.length) return null;
  const years = [...new Set(rows.map((r) => r.year))].sort();
  const berths = [...new Set(rows.map((r) => r.berthName))];
  const at = new Map(rows.map((r) => [`${r.berthName}|${r.year}`, r]));
  return (
    <section className="space-y-2">
      <h2 className="flex items-baseline gap-2 text-sm font-medium">
        Usage from the workbook
        <span className="text-xs font-normal text-ink-muted">· days per berth per year, as the &ldquo;8 YR Dock Usage&rdquo; tab counted them</span>
      </h2>
      <div className="overflow-x-auto rounded-xl border bg-surface">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b text-left text-[11px] tracking-wide text-ink-muted uppercase">
            <tr><th className="px-3 py-2 font-medium">Berth</th>{years.map((y) => <th key={y} className="num px-3 py-2 text-right font-medium">{y}</th>)}</tr>
          </thead>
          <tbody>
            {berths.map((b) => {
              const first = rows.find((r) => r.berthName === b);
              return (
                <tr key={b} className="border-b last:border-0">
                  <td className="px-3 py-1.5 font-medium">{b}{!first?.berthId && <span className="ml-1.5 text-xs font-normal text-ink-muted">not a berth on record</span>}</td>
                  {years.map((y) => <td key={y} className="num px-3 py-1.5 text-right">{at.get(`${b}|${y}`)?.days ?? "—"}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
