/**
 * Sessions are a signed, httpOnly cookie: `{ sub: <user> }` as an HS256 JWT, 30 days. Nothing is stored server-side.
 * The role is NOT in the token: it's looked up in AUTH_ACCOUNTS on every read, so removing an account (or changing its
 * role) takes effect on the next request. Safe to import from the proxy.
 */
import { SignJWT, jwtVerify } from "jose";
import type { Session } from "@shared/contract";
import { findAccount } from "./accounts";

export const SESSION_COOKIE = "dock.session";
export const SESSION_DAYS = 30;

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) throw new Error("AUTH_SECRET is not set (openssl rand -base64 32; infrastructure.md §3).");
  return new TextEncoder().encode(s);
}

export async function signSession(user: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(user).setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`).sign(secret());
}

/** The session a cookie value proves, or null: missing, tampered, expired, or an account that no longer exists. */
export async function readSession(token: string | undefined | null): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    const a = findAccount(payload.sub);
    return a ? { user: a.user, role: a.role } : null;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_DAYS * 24 * 60 * 60,
});
