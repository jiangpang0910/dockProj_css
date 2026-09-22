/** Test accounts (one per role, plus a second editor) and a signed cookie for any of them. */
import { signSession, SESSION_COOKIE } from "@/server/auth/session";

export const ACCOUNTS = [
  { user: "admin", password: "admin-pw", role: "admin" },
  { user: "editor", password: "editor-pw", role: "editor" },
  { user: "other", password: "other-pw", role: "editor" },
  { user: "viewer", password: "viewer-pw", role: "viewer" },
] as const;

export function installAccounts(): void {
  process.env.AUTH_SECRET = "test-secret-at-least-16-chars";
  process.env.AUTH_ACCOUNTS = JSON.stringify(ACCOUNTS);
}

export async function cookieFor(user: (typeof ACCOUNTS)[number]["user"]): Promise<string> {
  return `${SESSION_COOKIE}=${await signSession(user)}`;
}
