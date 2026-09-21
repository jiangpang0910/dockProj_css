import type { Metadata } from "next";
import { Suspense } from "react";
import { ConflictsScreen } from "@/components/screens/conflicts";

export const metadata: Metadata = { title: "Conflicts" };
export default function Page() {
  return <Suspense><ConflictsScreen /></Suspense>;
}
