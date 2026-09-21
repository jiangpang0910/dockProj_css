import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingsScreen } from "@/components/screens/bookings";

export const metadata: Metadata = { title: "Bookings" };
export default function Page() {
  return <Suspense><BookingsScreen /></Suspense>;
}
