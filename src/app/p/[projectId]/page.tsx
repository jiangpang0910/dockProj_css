import { Suspense } from "react";
import { CalendarView } from "@/components/calendar/calendar-view";

export default function SchedulePage() {
  return <Suspense><CalendarView /></Suspense>;
}
