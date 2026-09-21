import type { Metadata } from "next";
import { Suspense } from "react";
import { ImportScreen } from "@/components/screens/import";

export const metadata: Metadata = { title: "Import" };
export default function Page() {
  return <Suspense><ImportScreen /></Suspense>;
}
