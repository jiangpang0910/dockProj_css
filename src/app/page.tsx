import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/current";
import { workspaceId } from "@/server/services/projects";

// One workspace for everyone: the sample workbook, seeded once and edited in place. "/" just opens it.
export const dynamic = "force-dynamic";

export default async function Landing() {
  const me = await getSession();
  if (!me) redirect("/login");   // the proxy already does this; belt and braces
  const pid = await workspaceId();
  if (pid) redirect(`/p/${pid}`);
  return (
    <div className="scene scene-aerial grid min-h-dvh place-items-center px-5 text-center">
      <div className="max-w-md rounded-2xl border bg-surface p-6 shadow-xl">
        <h1 className="font-display text-2xl">The workspace isn&rsquo;t seeded yet</h1>
        <p className="mt-2 text-sm text-ink-muted">Run <code className="num">npm run db:seed</code> against this database to load the workbook, then reload.</p>
      </div>
    </div>
  );
}
