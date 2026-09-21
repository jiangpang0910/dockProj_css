"use client";
// New project (frontend.md §3.0b): one page, three steps, all visible at once.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { ArrowLeft, FileSpreadsheet, Loader2, Ship, Square } from "lucide-react";
import { DATE_MAX, DATE_MIN, HARD_HORIZON_YEARS, type ProjectOrigin } from "@shared/contract";
import { Logo } from "@/components/app/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiRequestError, errorMessage } from "@/lib/api/client";
import { createProject, inProject } from "@/lib/api/endpoints";
import { addYears, formatDay, isISODate, todayIn } from "@/lib/dates";
import { rememberProject } from "@/lib/projects-store";
import { UploadBox, checkUpload } from "@/components/import/upload-box";
import { cn } from "@/lib/utils";

type Start = "defaults" | "empty" | "upload";


export function NewProject() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [from, setFrom] = useState(() => todayIn());
  const [start, setStart] = useState<Start>("defaults");
  const [file, setFile] = useState<File | null>(null);
  const [until, setUntil] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [step, setStep] = useState<"idle" | "creating" | "uploading">("idle");
  const untilValue = until || (isISODate(from) ? addYears(from, HARD_HORIZON_YEARS) : "");

  const create = useMutation({
    mutationFn: async () => {
      setStep("creating");
      const origin: ProjectOrigin = start === "upload" ? "empty" : start;
      const p = await createProject({ name: name.trim(), start: origin, asOfDate: isISODate(from) ? from : null });
      rememberProject(p);          // remember before uploading, so a failed upload doesn't lose the project
      if (start === "upload" && file) {
        setStep("uploading");
        try {
          const run = await inProject(p.id).uploadImport(file, untilValue || undefined);
          return `/p/${p.id}/import?run=${run.id}`;
        } catch (e) {
          throw Object.assign(new Error(`Project created, but the upload failed: ${errorMessage(e)}`), { pid: p.id });
        }
      }
      return `/p/${p.id}`;
    },
    onSuccess: (href) => router.push(href),
    onError: () => setStep("idle"),
  });

  const pickFile = (f: File | undefined | null) => {
    setFileError(null);
    if (!f) return;
    const problem = checkUpload(f);
    if (problem) { setFileError(problem); return; }
    setFile(f);
  };

  const canCreate = name.trim().length > 0 && isISODate(from) && (start !== "upload" || !!file) && !create.isPending;
  const full = create.error instanceof ApiRequestError && create.error.status === 503;
  const partialPid = (create.error as (Error & { pid?: string }) | null)?.pid;

  return (
    <div className="scene scene-sunrise min-h-dvh">
      <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8">
        <header className="mb-10 flex items-center justify-between">
          <Link href="/" aria-label="Home"><Logo /></Link>
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ArrowLeft className="size-4" /> Back</Link>
        </header>
        <h1 className="font-display text-4xl leading-none tracking-tight">New project</h1>
        <p className="mt-2 text-ink-muted">A workspace of your own: its own berths, vessels and bookings.</p>

        <form className="mt-8 space-y-8 rounded-2xl border bg-surface p-5 shadow-2xl shadow-black/20 sm:p-8" onSubmit={(e) => { e.preventDefault(); if (canCreate) create.mutate(); }}>
          <Step n={1} title="Name and planning date">
            <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
              <div className="space-y-1.5">
                <Label htmlFor="np-name">Project name</Label>
                <Input id="np-name" autoFocus maxLength={80} placeholder="Summer 2008 season" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-from">Planning from</Label>
                <Input id="np-from" type="date" min={DATE_MIN} max={DATE_MAX} className="num" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-ink-muted">
              &ldquo;Planning from&rdquo; becomes the project&rsquo;s <em>today</em>: the earliest date you&rsquo;re planning for.
              E.g. <span className="num">2008-04-27</span> to plan the 2008 season with the old workbook.
            </p>
          </Step>

          <Step n={2} title="Starting point">
            <div role="radiogroup" aria-label="Starting point" className="grid gap-3 sm:grid-cols-3">
              <Card active={start === "defaults"} onClick={() => setStart("defaults")} icon={<Ship />} title="Default fleet"
                body="6 berths, 2 shared sections, 164 vessels from the WHOI workbook. No bookings." />
              <Card active={start === "empty"} onClick={() => setStart("empty")} icon={<Square />} title="Empty"
                body="Add berths and vessels yourself." />
              <Card active={start === "upload"} onClick={() => setStart("upload")} icon={<FileSpreadsheet />} title="Upload a spreadsheet"
                body="Your own fleet and bookings." />
            </div>
            <AnimatePresence initial={false}>
              {start === "upload" && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  <UploadBox file={file} onFile={pickFile} error={fileError} />
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="np-until">Planning until</Label>
                      <Input id="np-until" type="date" min={from} max={DATE_MAX} className="num" value={untilValue} onChange={(e) => setUntil(e.target.value)} />
                    </div>
                    <p className="self-end text-xs text-ink-muted">
                      Only bookings touching <span className="num">{isISODate(from) ? formatDay(from) : "…"}</span> →{" "}
                      <span className="num">{untilValue ? formatDay(untilValue) : "…"}</span> are brought in.
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </Step>

          <Step n={3} title="Create">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="lg" className="h-10 px-5" disabled={!canCreate}>
                {create.isPending && <Loader2 className="animate-spin" />}
                {step === "creating" ? "Creating…" : step === "uploading" ? "Reading your spreadsheet…" : "Create project"}
              </Button>
              {!name.trim() && <span className="text-sm text-ink-muted">Give it a name first.</span>}
            </div>
            {full && <p role="alert" className="rounded-md border border-brass/50 bg-brass-soft px-3 py-2 text-sm">The demo is full right now — try again tomorrow.</p>}
            {create.error && !full && (
              <p role="alert" className="text-sm text-signal">
                {errorMessage(create.error)}{" "}
                {partialPid && <Link className="underline" href={`/p/${partialPid}/import`}>Open the project and try the upload again</Link>}
              </p>
            )}
          </Step>
        </form>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 sm:grid-cols-[2.5rem_1fr]">
      <div className="num grid size-8 place-items-center rounded-full border bg-surface text-sm font-medium text-harbor">{n}</div>
      <div className="space-y-3">
        <h2 className="font-semibold">{title}</h2>
        {children}
      </div>
    </section>
  );
}

function Card({ active, onClick, icon, title, body }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; body: string }) {
  return (
    <button type="button" role="radio" aria-checked={active} onClick={onClick}
      className={cn("flex flex-col gap-2 rounded-xl border bg-surface p-4 text-left transition-all [&_svg]:size-5",
        active ? "border-harbor shadow-[0_0_0_3px_color-mix(in_oklab,var(--harbor)_18%,transparent)]" : "hover:border-ink-muted/40")}>
      <span className={active ? "text-harbor" : "text-ink-muted"}>{icon}</span>
      <span className="font-medium">{title}</span>
      <span className="text-sm leading-snug text-ink-muted">{body}</span>
    </button>
  );
}
