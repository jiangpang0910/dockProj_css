"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowRight, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiRequestError, errorMessage } from "@/lib/api/client";
import { createProject, deleteProject, listProjects } from "@/lib/api/endpoints";
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
      <div className="flex flex-wrap justify-center gap-3">
        <Button size="lg" className="h-11 px-5 text-[15px]" disabled={open.isPending || open.isSuccess} onClick={() => open.mutate()}>
          {open.isPending || open.isSuccess ? <Loader2 className="animate-spin" /> : null}
          {open.isPending || open.isSuccess ? (slow ? "Waking the database…" : "Copying the sample…") : "Open the sample"}
          {!open.isPending && !open.isSuccess && <ArrowRight />}
        </Button>
        <Link href="/new" className="inline-flex h-11 items-center gap-1.5 rounded-lg border bg-surface px-5 text-[15px] font-medium hover:bg-muted">
          <Plus className="size-4" /> New project
        </Link>
      </div>
      {full && <p role="alert" className="rounded-md border border-brass/50 bg-brass-soft px-3 py-2 text-sm">The demo is full right now — try again tomorrow.</p>}
      {open.error && !full && <p role="alert" className="text-sm text-signal">{errorMessage(open.error)}</p>}
    </div>
  );
}

const ORIGIN = { sample: "Sample", defaults: "Default fleet", empty: "Own data" } as const;

export function YourProjects() {
  const remembered = useRememberedProjects();
  const [deleting, setDeleting] = useState<Project | RememberedProject | null>(null);
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
    <section aria-labelledby="yours" className="w-full space-y-3 text-left">
      <h2 id="yours" className="text-center text-xs font-semibold tracking-[0.14em] text-ink-muted uppercase">Your projects</h2>
      <ul className="grid gap-2">
        {items.map((p, i) => (
          <motion.li key={p.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} className="group/card relative">
            <Link href={`/p/${p.id}`} className="group flex items-center gap-3 rounded-lg border bg-surface p-3 pr-12 transition-colors hover:border-harbor/50">
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
            {/* a sibling of the link, not inside it: a button nested in an <a> would also navigate */}
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${p.name}`} onClick={() => setDeleting(p)}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-muted hover:text-signal sm:opacity-0 sm:group-hover/card:opacity-100 sm:focus-visible:opacity-100">
              <Trash2 />
            </Button>
          </motion.li>
        ))}
      </ul>
      <Dialog open={!!deleting} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        {deleting && <DeleteProject project={deleting} onDone={() => setDeleting(null)} />}
      </Dialog>
    </section>
  );
}

function DeleteProject({ project, onDone }: { project: Project | RememberedProject; onDone: () => void }) {
  const isSample = "origin" in project && project.origin === "sample";
  const del = useMutation({
    mutationFn: () => deleteProject(project.id),
    onSuccess: () => { forgetProjects([project.id]); onDone(); },
    // already gone (e.g. cleaned up after 14 idle days): just take it off the list
    onError: (e) => { if (e instanceof ApiRequestError && e.status === 404) { forgetProjects([project.id]); onDone(); } },
  });
  return (
    <DialogContent className="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Delete {project.name}?</DialogTitle>
        <DialogDescription>
          Its berths, vessels and bookings go with it. This can&rsquo;t be undone.
          {isSample && " The sample itself stays: “Open the sample” makes a fresh copy any time."}
        </DialogDescription>
      </DialogHeader>
      {del.error && !(del.error instanceof ApiRequestError && del.error.status === 404) && (
        <p role="alert" className="rounded-md border border-signal/40 bg-signal-soft px-3 py-2 text-sm">{errorMessage(del.error)}</p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>Keep it</Button>
        <Button variant="destructive" disabled={del.isPending} onClick={() => del.mutate()}>
          {del.isPending && <Loader2 className="animate-spin" />} Delete
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
