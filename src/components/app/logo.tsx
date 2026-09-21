import { cn } from "@/lib/utils";

/** Dockmaster mark: a berth seen from above — a quay line with a hull alongside and a tide mark. */
export function Logo({ className, withWord = true }: { className?: string; withWord?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-ink", className)}>
      <svg viewBox="0 0 28 28" className="size-6" aria-hidden>
        <rect x="1" y="1" width="26" height="26" rx="6" className="fill-harbor" />
        <path d="M6 9h16" className="stroke-white/90" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M7 13.5h11.5a3 3 0 0 1 0 6H7z" className="fill-white/90" />
        <path d="M6 23c1.6-1 3.2-1 4.8 0s3.2 1 4.8 0 3.2-1 4.8 0" className="stroke-white/60" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      </svg>
      {withWord && <span className="text-[15px] font-semibold tracking-tight">Dockmaster</span>}
    </span>
  );
}
