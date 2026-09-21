import { Suspense } from "react";
import { ProjectShell } from "@/components/project/shell";

export default async function ProjectLayout({ children, params }: LayoutProps<"/p/[projectId]">) {
  const { projectId } = await params;
  return (
    <Suspense>
      <ProjectShell pid={projectId}>{children}</ProjectShell>
    </Suspense>
  );
}
