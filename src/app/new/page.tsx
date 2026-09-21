import type { Metadata } from "next";
import { NewProject } from "./new-project";

export const metadata: Metadata = { title: "New project" };
export default function Page() { return <NewProject />; }
