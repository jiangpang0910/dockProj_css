// Page gate (Next 16 "proxy", formerly middleware): no session cookie → /login. This is the optimistic redirect only;
// the real check is in src/server/http/route.ts, which every API route goes through.
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readSession } from "@/server/auth/session";

export async function proxy(req: NextRequest) {
  const session = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
  const { pathname, search } = req.nextUrl;
  if (pathname === "/login") {
    return session ? NextResponse.redirect(new URL(req.nextUrl.searchParams.get("next") || "/", req.url)) : NextResponse.next();
  }
  if (session) return NextResponse.next();
  const login = new URL("/login", req.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

// Only pages. Never match _next/static or /api: assets must load on the login page, and the API answers 401 itself.
export const config = { matcher: ["/", "/login", "/new", "/p/:path*"] };
