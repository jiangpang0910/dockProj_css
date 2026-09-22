/** Username + password check against AUTH_ACCOUNTS. Node-only (timing-safe compare); called from the login action. */
import { createHash, timingSafeEqual } from "node:crypto";
import { accounts, type Account } from "./accounts";

const digest = (s: string) => createHash("sha256").update(s).digest();

export function verifyLogin(user: string, password: string): Account | null {
  // Compare against every account so a wrong username costs the same as a wrong password.
  let match: Account | null = null;
  const given = digest(password);
  for (const a of accounts()) {
    const same = timingSafeEqual(digest(a.password), given);
    if (same && a.user === user) match = a;
  }
  return match;
}
