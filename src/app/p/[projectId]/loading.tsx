export default function Loading() {
  return (
    <div className="space-y-4 p-5" aria-busy aria-label="Loading">
      <div className="h-7 w-56 animate-pulse rounded bg-muted" />
      <div className="h-80 animate-pulse rounded-xl bg-muted/70" />
    </div>
  );
}
