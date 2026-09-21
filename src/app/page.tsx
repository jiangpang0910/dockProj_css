import { Logo } from "@/components/app/logo";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { OpenSample, YourProjects } from "@/components/landing/landing-actions";

// Static: renders instantly even while the database wakes up (frontend.md §3.0a).
// The aerial photo has open water down the middle, so everything sits centred in that channel.
export default function Landing() {
  return (
    <div className="scene scene-aerial min-h-dvh">
      <div className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center px-5 py-8 text-center sm:py-10">
        <header className="relative flex w-full justify-center">
          <Logo />
          <ThemeToggle className="absolute right-0" />
        </header>
        <main className="flex flex-1 flex-col items-center justify-center gap-7 py-16">
          <h1 className="font-display text-[2rem] leading-[1.15] tracking-tight sm:text-[3.4rem]">
            Every berth.<br />Every day.
          </h1>
          <p className="text-[15px] text-balance text-ink-muted">No double bookings. No vessel too long for its berth.</p>
          <OpenSample />
        </main>
        <YourProjects />
      </div>
    </div>
  );
}
