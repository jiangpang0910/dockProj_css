/**
 * File bytes → ParsedWorkbook (shared/pipeline.ts), validated before anything trusts it.
 * Production: the Python parser is its own Vercel project at PARSER_URL (infrastructure.md §1).
 * Locally / tests / seed: spawn `python3 -m pipeline.cli --stdin` from the repo root — no server needed.
 */
import { spawn } from "node:child_process";
import { ParsedWorkbookSchema, type ParsedWorkbook } from "@shared/pipeline";

const TIMEOUT_MS = 55_000;

export async function parseWorkbook(bytes: Uint8Array, opts: { noModel?: boolean } = {}): Promise<ParsedWorkbook> {
  const raw = process.env.PARSER_URL ? await viaHttp(bytes) : await viaCli(bytes, opts.noModel ?? false);
  return ParsedWorkbookSchema.parse(raw);
}

async function viaHttp(bytes: Uint8Array): Promise<unknown> {
  const res = await fetch(`${process.env.PARSER_URL!.replace(/\/$/, "")}/api/parse`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-parser-secret": process.env.PARSER_SECRET ?? "" },
    body: bytes as BodyInit,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`parser responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function viaCli(bytes: Uint8Array, noModel: boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = ["-m", "pipeline.cli", "--stdin", ...(noModel ? ["--no-model"] : [])];
    const child = spawn(process.env.PYTHON ?? "python3", args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("parser timed out")); }, TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`parser exited ${code}: ${Buffer.concat(err).toString().slice(0, 500)}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString("utf8"))); } catch (e) { reject(e); }
    });
    child.stdin.on("error", () => {}); // parser may exit early on a bad file; the close handler reports it
    child.stdin.end(Buffer.from(bytes));
  });
}
