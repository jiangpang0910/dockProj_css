/**
 * SolverInput → SolveResult (shared/solver.ts), validated before anything trusts it.
 * Production: the Python solver lives next to the parser, at $SOLVER_URL (default $PARSER_URL) + /api/solve.
 * Locally / tests: spawn `python3 -m pipeline.solve_cli` from the repo root, like the parser.
 */
import { spawn } from "node:child_process";
import type { SolveResult } from "@shared/contract";
import { SolveResultSchema, type SolverInput } from "@shared/solver";

const SLACK_MS = 20_000; // Python start-up + OR-Tools import + model build, on top of the solver's own time limit

export async function runSolver(input: SolverInput): Promise<SolveResult> {
  const timeout = input.options.timeLimitSec * 1000 + SLACK_MS;
  const url = process.env.SOLVER_URL ?? process.env.PARSER_URL;
  const raw = url ? await viaHttp(url, input, timeout) : await viaCli(input, timeout);
  return SolveResultSchema.parse(raw);
}

async function viaHttp(url: string, input: SolverInput, timeout: number): Promise<unknown> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/solve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-parser-secret": process.env.PARSER_SECRET ?? "" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`solver responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function viaCli(input: SolverInput, timeout: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON ?? "python3", ["-m", "pipeline.solve_cli"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("solver timed out")); }, timeout);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`solver exited ${code}: ${Buffer.concat(err).toString().slice(0, 500)}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString("utf8"))); } catch (e) { reject(e); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
