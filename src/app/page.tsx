import { redirect } from "next/navigation";
import { AccountBadge } from "@/components/app/account";
import { Logo } from "@/components/app/logo";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { OpenSample, YourProjects } from "@/components/landing/landing-actions";
import { getSession } from "@/server/auth/current";

// Reads the session cookie (so it's dynamic) but never the database: it renders even while Neon wakes up
// (frontend.md §3.0a). The aerial photo has open water down the middle, so everything sits centred in that channel.
export default async function Landing() {
  const me = await getSession();
  if (!me) redirect("/login");   // the proxy already does this; belt and braces
  return (
    <div className="scene scene-aerial min-h-dvh">
      <div className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center px-5 py-8 text-center sm:py-10">
        <header className="relative flex w-full justify-center">
          <Logo />
          <div className="absolute right-0 flex items-center gap-2">
            <AccountBadge me={me} className="hidden sm:inline-flex" />
            <ThemeToggle />
          </div>
        </header>
        <main className="flex flex-1 flex-col items-center justify-center gap-7 py-16">
          <h1 className="font-display text-[2rem] leading-[1.15] tracking-tight sm:text-[3.4rem]">
            Every berth.<br />Every day.
          </h1>
          <p className="text-[15px] text-balance text-ink-muted">No double bookings. No vessel too long for its berth.</p>
          <OpenSample readOnly={me.role === "viewer"} />
        </main>
        <YourProjects me={me} />
        <AccountBadge me={me} className="mt-6 sm:hidden" />
      </div>
    </div>
  );
}
