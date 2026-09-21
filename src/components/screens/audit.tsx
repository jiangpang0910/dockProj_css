"use client";
// Audit (frontend.md §3.8): re-check every rule over every confirmed booking. A healthy result is the hero.
import { useMutation } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import type { AuditReport } from "@shared/contract";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/client";
import { formatInstant } from "@/lib/dates";
import { plural } from "@/lib/format";
import { useBookingEditor } from "@/components/booking/booking-editor";
import { useProjectCtx } from "@/components/project/project-context";
import { ErrorBox, PageHeader } from "./page-header";

export function AuditScreen() {
  const { api } = useProjectCtx();
  const editor = useBookingEditor();
  const run = useMutation<AuditReport>({ mutationFn: () => api.audit() });
  const r = run.data;
  const groups = r ? Object.entries(r.summary) : [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-3 sm:p-5">
      <PageHeader title="Audit" sub="Re-checks no-overlap, fit and one-place-at-a-time over every confirmed booking. On a healthy schedule this finds nothing — that's the proof.">
        <Button onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />} {r ? "Run again" : "Run audit"}
        </Button>
      </PageHeader>

      {run.error && <ErrorBox message={errorMessage(run.error)} onRetry={() => run.mutate()} />}
      {!r && !run.isPending && !run.error && (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-ink-muted">Press <b>Run audit</b> to check every booking against every rule.</div>
      )}
      {run.isPending && <div className="h-48 animate-pulse rounded-xl bg-muted" />}

      {r && !run.isPending && (r.violations.length === 0 ? (
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="rounded-2xl border bg-surface px-6 py-12 text-center">
          <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.1 }}
            className="mx-auto grid size-16 place-items-center rounded-full bg-ok-soft text-ok">
            <ShieldCheck className="size-8" />
          </motion.div>
          <p className="mt-5 text-2xl font-semibold tracking-tight"><span className="num">{r.checkedBookings.toLocaleString()}</span> bookings checked · <span className="text-ok">0 violations</span></p>
          <p className="mt-2 text-sm text-ink-muted">No berth double-booked, no vessel too long, no vessel in two places. Checked {formatInstant(r.generatedAt)}.</p>
        </motion.div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-signal/40 bg-signal-soft p-4">
            <ShieldAlert className="size-6 text-signal" />
            <p><b className="num">{plural(r.violations.length, "booking")}</b> of <span className="num">{r.checkedBookings.toLocaleString()}</span> break a rule. The database should have prevented this — someone edited it outside the app.</p>
          </div>
          {groups.map(([code, n]) => (
            <section key={code} className="rounded-xl border bg-surface">
              <h2 className="flex items-center justify-between border-b px-4 py-2 text-sm"><span className="rounded bg-signal/10 px-1.5 font-mono text-[11px] font-semibold text-signal">{code}</span><span className="num text-ink-muted">{n}</span></h2>
              <ul className="divide-y">
                {r.violations.filter((v) => v.violations.some((x) => x.code === code)).map((v) => (
                  <li key={v.bookingId}>
                    <button type="button" onClick={() => editor.openDetail(v.bookingId)} className="w-full px-4 py-2 text-left text-sm hover:bg-accent">
                      {v.violations.find((x) => x.code === code)?.message} <span className="text-harbor">Open →</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ))}
    </div>
  );
}
