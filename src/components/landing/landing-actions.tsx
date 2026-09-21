"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowRight, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiRequestError, errorMessage } from "@/lib/api/client";
import { createProject, listProjects } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/keys";
import { formatInstant } from "@/lib/dates";
import { forgetProjects, rememberProject, useRememberedProjects, type RememberedProject } from "@/lib/projects-store";
import type { Project } from "@shared/contract";

export function OpenSample() {
  const router = useRouter();
  const [slow, setSlow] = useState(false);
  const open = useMutation({
    mutationFn: () => { setTimeout(() => setSlow(true), 1500); return createProject({ name: "Sample — WHOI dock", start: "sample" }); },
    onSuccess: (p) => { rememberProject(p); router.push(`/p/${p.id}`); },
  });
  const full = open.error instanceof ApiRequestError && open.error.status === 503;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Button size="lg" className="h-11 px-5 text-[15px]" disabled={open.isPending || open.isSuccess} onClick={() => open.mutate()}>
          {open.isPending || open.isSuccess ? <Loader2 className="animate-spin" /> : null}
          {open.isPending || open.isSuccess ? (slow ? "Waking the database…" : "Copying the sample…") : "Open the sample"}
          {!open.isPending && !open.isSuccess && <ArrowRight />}
        </Button>
        <Link href="/new" className="inline-flex h-11 items-center gap-1.5 rounded-lg border bg-surface px-5 text-[15px] font-medium hover:bg-muted">
          <Plus className="size-4" /> New project
        </Link>
      </div>
      <p className="text-sm text-ink-muted">Your own copy of 23 years of the WHOI schedule. Change anything, it&rsquo;s yours.</p>
      {full && <p role="alert" className="rounded-md border border-brass/50 bg-brass-soft px-3 py-2 text-sm">The demo is full right now — try again tomorrow.</p>}
      {open.error && !full && <p role="alert" className="text-sm text-signal">{errorMessage(open.error)}</p>}
    </div>
  );
}

const ORIGIN = { sample: "Sample", defaults: "Default fleet", empty: "Own data" } as const;

export function YourProjects() {
  const remembered = useRememberedProjects();
  const ids = remembered.map((r) => r.id);
  const q = useQuery({
    queryKey: qk.projects(ids),
    queryFn: async () => {
      const found = await listProjects(ids);
      const alive = new Set(found.map((p) => p.id));
      forgetProjects(ids.filter((id) => !alive.has(id)));   // cleaned up after 14 idle days — drop quietly
      return found;
    },
    enabled: ids.length > 0,
  });
  if (!ids.length) return null;
  const items: (Project | RememberedProject)[] = q.data ?? remembered;
  return (
    <section aria-labelledby="yours" className="space-y-3">
      <h2 id="yours" className="text-xs font-semibold tracking-[0.14em] text-ink-muted uppercase">Your projects</h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((p, i) => (
          <motion.li key={p.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
            <Link href={`/p/${p.id}`} className="group flex items-center gap-3 rounded-lg border bg-surface p-3 transition-colors hover:border-harbor/50">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{p.name}</span>
                  {"origin" in p && <span className="rounded border px-1.5 text-[10px] tracking-wide text-ink-muted uppercase">{ORIGIN[p.origin]}</span>}
                </div>
                {"counts" in p ? (
                  <p className="num mt-0.5 text-xs text-ink-muted">
                    {p.counts.berths} berths · {p.counts.vessels} vessels · {p.counts.bookings.toLocaleString()} bookings · opened {formatInstant(p.lastOpenedAt)}
                  </p>
                ) : <p className="mt-1 h-3 w-48 animate-pulse rounded bg-muted" />}
              </div>
              <ArrowRight className="size-4 text-ink-muted transition-transform group-hover:translate-x-0.5" />
            </Link>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}
