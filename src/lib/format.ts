import type { OccupantType } from "@shared/contract";

/** Lengths render with a prime: 410′ (frontend.md §2). */
export const ft = (n: number | null | undefined) => (n == null ? "—" : `${Number.isInteger(n) ? n : n.toFixed(1)}′`);
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const occupantLabel: Record<OccupantType, string> = { vessel: "Vessel", event: "Event", closure: "Closure" };
