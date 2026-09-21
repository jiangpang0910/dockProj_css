// src/lib/api/client.ts — the one place that talks HTTP (frontend.md §7.4).
// With NEXT_PUBLIC_API_MOCK=1 the same requests are answered by an in-browser mock (src/lib/api/mock);
// components never know the difference.
import type { ApiError } from "@shared/contract";

const BASE = "/api";
const MOCK = process.env.NEXT_PUBLIC_API_MOCK === "1";

export class ApiRequestError extends Error {
  constructor(public status: number, public body: ApiError) { super(body.error.message); }
}

type Init = RequestInit & { json?: unknown };

async function transport(url: string, init: RequestInit): Promise<Response> {
  if (MOCK) {
    const { mockFetch } = await import("./mock/server");
    return mockFetch(url, init);
  }
  return fetch(url, init);
}

export async function api<T>(path: string, init?: Init): Promise<T> {
  const { json, headers, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await transport(`${BASE}${path}`, {
      ...rest,
      headers: json !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiRequestError(0, { error: { code: "INTERNAL", message: "Can't reach the server. Check your connection and retry." } });
  }
  if (res.status === 204) return undefined as T;
  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const err = (body as ApiError | null)?.error ? (body as ApiError)
      : { error: { code: "INTERNAL" as const, message: `Request failed (${res.status}).` } };
    throw new ApiRequestError(res.status, err);
  }
  return body as T;
}

export const qs = (p: Record<string, string | number | boolean | undefined | null>) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)])).toString();

/** Human message for any thrown error. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.body.error.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
