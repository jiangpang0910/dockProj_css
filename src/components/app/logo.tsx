import Image from "next/image";
import { cn } from "@/lib/utils";

/** Dockmaster mark: a booked-date pin over a boat at its berth. */
export function Logo({ className, withWord = true }: { className?: string; withWord?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-ink", className)}>
      <Image src="/logo.png" alt="" width={512} height={512} className="size-8 shrink-0" priority />
      {withWord && <span className="text-[15px] font-semibold tracking-tight">Dockmaster</span>}
    </span>
  );
}
