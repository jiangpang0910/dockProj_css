import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ProjectShell } from "@/components/project/shell";
import { getSession } from "@/server/auth/current";

export default async function ProjectLayout({ children, params }: LayoutProps<"/p/[projectId]">) {
  const { projectId } = await params;
  const me = await getSession();
  if (!me) redirect(`/login?next=${encodeURIComponent(`/p/${projectId}`)}`);   // the proxy already does this; belt and braces
  return (
    <Suspense>
      <ProjectShell pid={projectId} me={me}>{children}</ProjectShell>
    </Suspense>
  );
}
