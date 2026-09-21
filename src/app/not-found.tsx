import Link from "next/link";
import { Logo } from "@/components/app/logo";

export default function NotFound() {
  return (
    <div className="chart-ground grid min-h-dvh place-items-center p-6">
      <div className="max-w-sm rounded-xl border bg-surface p-6 text-center">
        <Logo withWord={false} className="justify-center" />
        <h1 className="mt-4 text-lg font-semibold">Nothing moored here</h1>
        <p className="mt-2 text-sm text-ink-muted">That page doesn&rsquo;t exist.</p>
        <Link href="/" className="mt-5 inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm text-primary-foreground">Back to the start</Link>
      </div>
    </div>
  );
}
