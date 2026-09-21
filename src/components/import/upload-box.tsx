"use client";
import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { cn } from "@/lib/utils";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Checks a picked file before any upload: .xlsx only, ≤ 4 MB (infrastructure.md §6). Returns an error or null. */
export function checkUpload(f: File): string | null {
  if (!/\.xlsx$/i.test(f.name)) return "That isn't an .xlsx file.";
  if (f.size > MAX_UPLOAD_BYTES) return `That file is ${(f.size / 1048576).toFixed(1)} MB; the limit is 4 MB.`;
  return null;
}

export function UploadBox({ file, onFile, error }: { file: File | null; onFile: (f: File | null | undefined) => void; error: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div className="mt-4 space-y-3 rounded-xl border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-ink-muted">Three sheets: <b className="font-medium text-ink">Berths</b> · <b className="font-medium text-ink">Vessels</b> · <b className="font-medium text-ink">Bookings</b></span>
        <a href="/dock-template.xlsx" download className="inline-flex items-center gap-1.5 text-harbor hover:underline"><Download className="size-4" /> Download the template</a>
      </div>
      <button type="button" onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]); }}
        className={cn("flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-sm transition-colors",
          over ? "border-harbor bg-harbor-soft" : "border-input hover:border-ink-muted/50")}>
        <Upload className="size-5 text-ink-muted" />
        {file ? <span><b className="font-medium">{file.name}</b> <span className="num text-ink-muted">· {(file.size / 1024).toFixed(0)} KB</span></span>
              : <span>Drop an <b className="font-medium">.xlsx</b> here, or click to choose</span>}
        <span className="text-xs text-ink-muted">The original year-per-sheet workbook works too.</span>
      </button>
      <input ref={input} type="file" accept=".xlsx" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
      {error && <p role="alert" className="text-sm text-signal">{error}</p>}
    </div>
  );
}
