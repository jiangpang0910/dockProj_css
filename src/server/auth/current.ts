/** The signed-in account for the current server render / action (reads the request cookie). */
import { cookies } from "next/headers";
import type { Session } from "@shared/contract";
import { SESSION_COOKIE, readSession } from "./session";

export async function getSession(): Promise<Session | null> {
  return readSession((await cookies()).get(SESSION_COOKIE)?.value);
}
