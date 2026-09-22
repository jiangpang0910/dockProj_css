import type { ApiError, Violation } from "@shared/contract";

export type ApiErrorCode = ApiError["error"]["code"];

const STATUS: Record<ApiErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_VERSION: 409,
  UNPROCESSABLE: 422,
  INTERNAL: 500,
  UNAVAILABLE: 503,
};

/** Every expected failure a service can raise. The route wrapper turns it into an ApiError body. */
export class ApiErr extends Error {
  readonly status: number;
  constructor(public code: ApiErrorCode, message: string, public violations?: Violation[]) {
    super(message);
    this.status = STATUS[code];
  }
  body(): ApiError {
    return { error: { code: this.code, message: this.message, ...(this.violations ? { violations: this.violations } : {}) } };
  }
}

export const notFound = (what: string) => new ApiErr("NOT_FOUND", `${what} not found.`);
export const badRequest = (message: string) => new ApiErr("VALIDATION", message);
export const unauthorized = () => new ApiErr("UNAUTHORIZED", "Sign in to continue.");
export const forbidden = (message: string) => new ApiErr("FORBIDDEN", message);

/** backend.md §4: any schedule-state violation (overlap, double-berthed) → 409; otherwise 422. All violations included. */
export function ruleError(violations: Violation[]): ApiErr {
  const errors = violations.filter((v) => v.severity === "error");
  const conflict = errors.some((v) => v.code === "OVERLAP" || v.code === "VESSEL_DOUBLE_BERTHED");
  const message = errors.map((v) => v.message).join(" ");
  return new ApiErr(conflict ? "CONFLICT" : "UNPROCESSABLE", message, violations);
}
