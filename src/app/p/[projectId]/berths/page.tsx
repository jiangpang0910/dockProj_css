import type { Metadata } from "next";
import { Suspense } from "react";
import { BerthsScreen } from "@/components/screens/berths";

export const metadata: Metadata = { title: "Berths" };
export default function Page() {
  return <Suspense><BerthsScreen /></Suspense>;
}
