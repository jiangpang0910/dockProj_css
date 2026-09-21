import type { Metadata } from "next";
import { Suspense } from "react";
import { AvailabilityScreen } from "@/components/screens/availability";

export const metadata: Metadata = { title: "Availability" };
export default function Page() {
  return <Suspense><AvailabilityScreen /></Suspense>;
}
