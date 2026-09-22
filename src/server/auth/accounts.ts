/**
 * The accounts that can sign in (infrastructure.md §5). There is no sign-up: logins are handed out, and they live in
 * one env var so adding one is `vercel env add AUTH_ACCOUNTS` and a redeploy:
 *
 *   AUTH_ACCOUNTS='[{"user":"admin","password":"…","role":"admin"},{"user":"judge","password":"…","role":"editor"}]'
 *
 * No Node-only imports here: the proxy (src/proxy.ts) reads this too.
 */
import { z } from "zod";
import { ROLES, type Role } from "@shared/contract";

export interface Account { user: string; password: string; role: Role }

const AccountsSchema = z.array(z.object({
  user: z.string().trim().min(1).max(40),
  password: z.string().min(1),
  role: z.enum(ROLES),
})).min(1);

let cache: { raw: string; list: Account[] } | null = null;

/** Parsed AUTH_ACCOUNTS. Throws a clear message when it's missing or malformed (a config error, not a login error). */
export function accounts(): Account[] {
  const raw = process.env.AUTH_ACCOUNTS;
  if (!raw) throw new Error("AUTH_ACCOUNTS is not set: a JSON list of {user, password, role} (infrastructure.md §3).");
  if (cache?.raw === raw) return cache.list;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("AUTH_ACCOUNTS is not valid JSON."); }
  const r = AccountsSchema.safeParse(parsed);
  if (!r.success) throw new Error(`AUTH_ACCOUNTS: ${r.error.issues.map((i) => `${i.path.join(".") || "list"}: ${i.message}`).join("; ")}`);
  const seen = new Set<string>();
  for (const a of r.data) {
    if (seen.has(a.user)) throw new Error(`AUTH_ACCOUNTS: "${a.user}" appears twice.`);
    seen.add(a.user);
  }
  cache = { raw, list: r.data };
  return r.data;
}

export function findAccount(user: string): Account | null {
  return accounts().find((a) => a.user === user) ?? null;
}
