import type { Metadata } from "next";
import { Suspense } from "react";
import { AuditScreen } from "@/components/screens/audit";

export const metadata: Metadata = { title: "Audit" };
export default function Page() {
  return <Suspense><AuditScreen /></Suspense>;
}
