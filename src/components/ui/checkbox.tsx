"use client";
// A native checkbox in the app's palette. Native keeps keyboard, focus and screen-reader behaviour for free;
// `indeterminate` is a DOM property, so it is set through a ref.
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export function Checkbox({ indeterminate, className, ...props }:
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <input ref={ref} type="checkbox" data-slot="checkbox"
      className={cn("size-4 shrink-0 cursor-pointer rounded border-input accent-[var(--harbor)] disabled:cursor-not-allowed disabled:opacity-50", className)}
      {...props} />
  );
}
