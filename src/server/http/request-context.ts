/**
 * Per-request memo of the project row. `route()` already loads the project to authorize the caller; services that
 * only read can reuse that row instead of paying a second database round trip (each one is ~80 ms from a laptop to
 * Neon). Writes never use it: they re-read inside their own transaction.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ProjectRow } from "../services/projects";

export const requestProject = new AsyncLocalStorage<{ pid: string; row: ProjectRow }>();
