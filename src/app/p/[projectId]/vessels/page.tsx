import type { Metadata } from "next";
import { Suspense } from "react";
import { VesselsScreen } from "@/components/screens/vessels";

export const metadata: Metadata = { title: "Vessels" };
export default function Page() {
  return <Suspense><VesselsScreen /></Suspense>;
}
