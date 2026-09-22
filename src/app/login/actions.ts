"use server";
// Sign in / sign out. The cookie is the whole session (src/server/auth/session.ts); nothing is written to the DB.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyLogin } from "@/server/auth/login";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/server/auth/session";

export interface LoginState { error?: string }

/** Only same-origin paths: never bounce a fresh login to another site. */
function safeNext(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const user = String(form.get("user") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!user || !password) return { error: "Enter the username and password you were given." };
  const account = verifyLogin(user, password);
  if (!account) return { error: "That username and password don't match." };
  (await cookies()).set(SESSION_COOKIE, await signSession(account.user), sessionCookieOptions());
  redirect(safeNext(form.get("next")));
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
