"use client";
// The frame inside a project: left rail, top bar (project menu, "today" chip, New booking), content.
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/app/theme-toggle";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarDays, ChevronDown, Copy, Flag, List, Pencil, Plus, Search, Ship, TriangleAlert, Waves,
} from "lucide-react";
import { AccountBadge } from "@/components/app/account";
import { Logo } from "@/components/app/logo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { Session } from "@shared/contract";
import { BookingEditorProvider, useBookingEditor } from "@/components/booking/booking-editor";
import { ApiRequestError, errorMessage } from "@/lib/api/client";
import { renameProject } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/keys";
import { cn } from "@/lib/utils";
import { ProjectProvider, useProject, useProjectCtx } from "./project-context";
import { TodayChip } from "./today-chip";

const NAV = [
  { href: "", label: "Schedule", icon: CalendarDays },
  { href: "/availability", label: "Availability", icon: Search },
  { href: "/bookings", label: "Bookings", icon: List },
  { href: "/vessels", label: "Vessels", icon: Ship },
  { href: "/events", label: "Events", icon: Flag },
  { href: "/berths", label: "Berths", icon: Waves },
  { href: "/conflicts", label: "Conflicts", icon: TriangleAlert },
];

export function ProjectShell({ pid, me, children }: { pid: string; me: Session; children: React.ReactNode }) {
  return (
    <ProjectProvider pid={pid}>
      <BookingEditorProvider>
        <Frame me={me}>{children}</Frame>
      </BookingEditorProvider>
    </ProjectProvider>
  );
}

function Frame({ me, children }: { me: Session; children: React.ReactNode }) {
  const { pid, api } = useProjectCtx();
  const project = useProject();
  const conflicts = useQuery({ queryKey: qk.conflictSummary(pid), queryFn: () => api.conflictSummary() });
  const pathname = usePathname();
  const editor = useBookingEditor();

  // N = new booking, anywhere in the project, unless typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (e.key === "n" || e.key === "N") { e.preventDefault(); editor.openNew(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);

  if (project.error instanceof ApiRequestError && (project.error.status === 404 || project.error.status === 403)) {
    return <Gone status={project.error.status} />;
  }

  const base = `/p/${pid}`;
  const openConflicts = conflicts.data?.open ?? 0;
  const isActive = (href: string) => (href === "" ? pathname === base : pathname.startsWith(base + href));

  return (
    <div className="scene scene-harbor flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col border-r bg-surface/70 px-3 py-4 backdrop-blur md:flex">
        <Link href="/" className="mb-6 px-2" aria-label="Dockmaster home"><Logo /></Link>
        <nav aria-label="Project" className="flex flex-col gap-0.5">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link key={label} href={base + href} aria-current={isActive(href) ? "page" : undefined}
              className={cn("flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                isActive(href) ? "bg-harbor-soft font-medium text-ink" : "text-ink-muted hover:bg-muted hover:text-ink")}>
              <Icon className={cn("size-4", isActive(href) && "text-harbor")} /> {label}
              {href === "/conflicts" && openConflicts > 0 && (
                <span className="num ml-auto rounded-full bg-signal-soft px-1.5 text-[11px] font-medium text-signal">{openConflicts}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-1 px-2 text-[11px] leading-relaxed text-ink-muted">
          <p><kbd className="rounded border px-1 font-mono">N</kbd> new booking</p>
          <p>Every length in feet, every date inclusive.</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b bg-paper/85 backdrop-blur">
          <div className="flex h-12 items-center gap-2 px-3 sm:px-5">
            <Link href="/" className="md:hidden" aria-label="Home"><Logo withWord={false} /></Link>
            <ProjectMenu />
            <div className="flex-1" />
            <AccountBadge me={me} className="hidden lg:inline-flex" />
            <ThemeToggle className="hidden sm:inline-flex" />
            <TodayChip />
            <Button size="sm" onClick={() => editor.openNew()} className="gap-1.5">
              <Plus /> <span className="hidden sm:inline">New booking</span>
              <kbd className="ml-0.5 hidden rounded bg-white/15 px-1 font-mono text-[10px] sm:inline">N</kbd>
            </Button>
          </div>
          <nav aria-label="Project (mobile)" className="flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
            {NAV.map(({ href, label }) => (
              <Link key={label} href={base + href} className={cn("shrink-0 rounded-md px-2.5 py-1 text-xs",
                isActive(href) ? "bg-harbor-soft font-medium" : "text-ink-muted")}>{label}</Link>
            ))}
          </nav>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function ProjectMenu() {
  const { pid } = useProjectCtx();
  const project = useProject();
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const rename = useMutation({
    mutationFn: () => renameProject(pid, { name: name.trim() }),
    onSuccess: (p) => { qc.setQueryData(qk.project(pid), p); setRenaming(false); },
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium hover:bg-muted">
          {project.data ? (
            <>
              <span className="truncate">{project.data.name}</span>
            </>
          ) : <span className="h-4 w-32 animate-pulse rounded bg-muted" />}
          <ChevronDown className="size-3.5 text-ink-muted" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuItem onClick={() => { setName(project.data?.name ?? ""); setRenaming(true); }}><Pencil /> Rename</DropdownMenuItem>
          <DropdownMenuItem onClick={async () => {
            try { await navigator.clipboard.writeText(`${location.origin}/p/${pid}`); toast.success("Link copied. It opens for this login and for admins."); }
            catch { toast.error("Couldn't copy — the link is in your address bar."); }
          }}><Copy /> Copy link</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Rename project</DialogTitle></DialogHeader>
          <form id="rename" onSubmit={(e) => { e.preventDefault(); if (name.trim()) rename.mutate(); }}>
            <Input autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} aria-label="Project name" />
            {rename.error && <p className="mt-2 text-xs text-signal">{errorMessage(rename.error)}</p>}
          </form>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
            <Button type="submit" form="rename" disabled={!name.trim() || rename.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Gone({ status }: { status: 403 | 404 }) {
  return (
    <div className="scene scene-sunrise grid min-h-dvh place-items-center p-6">
      <div className="max-w-sm rounded-xl border bg-surface p-6 text-center shadow-sm">
        <Logo withWord={false} className="justify-center" />
        <h1 className="mt-4 text-lg font-semibold">{status === 403 ? "This project belongs to another login" : "This project no longer exists"}</h1>
        <p className="mt-2 text-sm text-ink-muted">
          {status === 403
            ? "Sign in with that account, or ask an admin — admins can open every project."
            : "Projects nobody opens for 14 days are cleared away. Start a fresh one — the sample takes a second."}
        </p>
        <Link href="/" className="mt-5 inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm text-primary-foreground">Back to the start</Link>
      </div>
    </div>
  );
}
