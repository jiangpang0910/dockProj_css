export function PageHeader({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-[1.75rem] leading-none tracking-tight">{title}</h1>
        {sub && <p className="mt-2 text-sm text-ink-muted">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-signal/30 bg-surface p-5 text-sm">
      <p className="text-signal">{message}</p>
      {onRetry && <button type="button" onClick={onRetry} className="mt-2 text-harbor hover:underline">Retry</button>}
    </div>
  );
}
