import { Logo } from "@/components/app/logo";
import { ChartPreview } from "@/components/landing/chart-preview";
import { OpenSample, YourProjects } from "@/components/landing/landing-actions";

// Static: renders instantly even while the database wakes up (frontend.md §3.0a).
export default function Landing() {
  return (
    <div className="chart-ground min-h-dvh">
      <div className="mx-auto flex max-w-6xl flex-col gap-14 px-5 py-8 sm:px-8 sm:py-12">
        <header className="flex items-center justify-between">
          <Logo />
          <span className="text-xs text-ink-muted">Berth scheduling for a marine research facility</span>
        </header>

        <section className="grid items-center gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="space-y-7">
            <p className="text-xs font-semibold tracking-[0.16em] text-harbor uppercase">Dock schedule</p>
            <h1 className="text-[2.35rem] leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl">
              Every berth, every day — and no vessel where it can&rsquo;t fit.
            </h1>
            <p className="max-w-md text-[15px] leading-relaxed text-ink-muted">
              Book vessels, events and closures onto the dock. Double bookings and too-long vessels are refused
              before you save, with the booking in the way named and a free berth suggested.
            </p>
            <OpenSample />
          </div>
          <ChartPreview />
        </section>

        <YourProjects />

        <footer className="border-t pt-5 text-xs text-ink-muted">
          No sign-in: a project&rsquo;s link is its key. Projects nobody opens for 14 days are cleared away.
        </footer>
      </div>
    </div>
  );
}
