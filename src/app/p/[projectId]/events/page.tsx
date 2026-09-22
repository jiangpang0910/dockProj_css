import type { Metadata } from "next";
import { Suspense } from "react";
import { EventsScreen } from "@/components/screens/events";

export const metadata: Metadata = { title: "Events" };
export default function Page() {
  return <Suspense><EventsScreen /></Suspense>;
}
