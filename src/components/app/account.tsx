"use client";
// Who's signed in, and the way out. Works anywhere: the logout server action clears the cookie and redirects.
import { LogOut } from "lucide-react";
import type { Session } from "@shared/contract";
import { logout } from "@/app/login/actions";
import { cn } from "@/lib/utils";

export const ROLE_LABEL = { admin: "Admin", editor: "Editor", viewer: "Read-only" } as const;

export function AccountBadge({ me, className }: { me: Session; className?: string }) {
  return (
    <div className={cn("inline-flex h-7 items-center gap-2 rounded-full border bg-surface pr-1 pl-3 text-xs", className)}>
      <span className="font-medium">{me.user}</span>
      <span className="rounded border px-1.5 text-[10px] tracking-wide text-ink-muted uppercase">{ROLE_LABEL[me.role]}</span>
      <form action={logout}>
        <button type="submit" aria-label="Sign out" title="Sign out" className="grid size-5 place-items-center rounded-full text-ink-muted hover:bg-muted hover:text-ink">
          <LogOut className="size-3.5" />
        </button>
      </form>
    </div>
  );
}
