/**
 * CP-SAT live monitor — http://localhost:3101 (npm run cpsat). A local dev tool, not part of the app.
 *
 * Builds a project's solver input exactly as auto-resolve does (buildSolverInput), runs the real solver in
 * cpsat/worker.py with every stage watched, and streams what it finds to the page (server-sent events), so you can
 * see how fast each stage converges and pick options.timeLimitSec. Each run is kept in cpsat/runs/ to compare later.
 * Reads the database; never writes to it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import type { SolveResult } from "@shared/contract";
import type { SolverInput } from "@shared/solver";
import { getDb } from "@/server/db/pool";
import { buildSolverInput, SOLVE_DEFAULTS } from "@/server/services/solve";

const PORT = Number(process.env.CPSAT_PORT ?? 3101);
const HERE = import.meta.dirname;
const ROOT = join(HERE, "..");
const RUNS = join(HERE, "runs"); // machine-readable events, replayed by the page
const LOGS = join(HERE, "logs"); // the same runs as plain text, to read: logs/<date>_<time>.log
mkdirSync(RUNS, { recursive: true });
mkdirSync(LOGS, { recursive: true });

interface Run {
  id: string; file: string; log: string | null; events: string[]; done: boolean; t0: number;
  child: ChildProcessWithoutNullStreams | null; listeners: Set<ServerResponse>;
}
const runs = new Map<string, Run>();

// ── runs ──

function startRun(input: SolverInput, stageSeconds: number, meta: Record<string, unknown>): Run {
  for (const r of runs.values()) r.child?.kill("SIGKILL"); // one solve at a time: they'd fight over the cores
  const id = stamp(new Date());
  const run: Run = { id, file: join(RUNS, `${id}.ndjson`), log: join(LOGS, `${id}.log`), events: [], done: false,
    t0: performance.now(), child: null, listeners: new Set() };
  runs.set(id, run);
  push(run, { type: "meta", id, stageSeconds, options: input.options, ...meta });

  const child = spawn(process.env.PYTHON ?? "python3", [join(HERE, "worker.py")], { cwd: ROOT });
  run.child = child;
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        push(run, { ...JSON.parse(line), at: (performance.now() - run.t0) / 1000 });
      } catch {
        push(run, { type: "log", line });
      }
    }
  });
  let err = "";
  child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
  child.on("close", (code, signal) => {
    run.child = null;
    if (code !== 0) push(run, { type: "error", message: signal ? `worker killed (${signal})` : `worker exited ${code}: ${err.slice(-800)}` });
    push(run, { type: "end" });
    run.done = true;
    for (const res of run.listeners) res.end();
    run.listeners.clear();
  });
  child.stdin.on("error", () => {});
  child.stdin.write(JSON.stringify({ input, stageSeconds }) + "\n");
  return run;
}

function push(run: Run, ev: Record<string, unknown>) {
  const line = JSON.stringify(ev);
  run.events.push(line);
  appendFileSync(run.file, line + "\n");
  if (run.log) {
    const text = describe(ev);
    if (text != null) {
      const ts = `[${clock(new Date())}]`;
      const gap = ev.type === "stage" || ev.type === "result" ? "\n" : ""; // a blank line before each section
      appendFileSync(run.log, gap + text.split("\n").map((l) => `${ts} ${l}`).join("\n") + "\n");
    }
  }
  for (const res of run.listeners) res.write(`data: ${line}\n\n`);
}

// ── the text log ──

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** 2026-09-22_12-13-56, local time: a run's id and its file names. */
function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
/** 2026-09-22 12:13:56.123, local time: each log line. */
function clock(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const STAGE_TITLES = ["Place as many as possible", "Least disruption", "Tightest fit", "Stay on requested berth"];
const UNITS = ["placed", "pts", "ft-days", "days off"];
const SCALE = [1, 1, 0.1, 1]; // stage 3 is solved in tenths of a foot
const secs = (t: unknown) => `${Number(t).toFixed(3)}s`;
const num = (v: unknown) => (v == null ? "-" : String(Math.round(Number(v) * 100) / 100));
function gap(obj: unknown, bound: unknown): string {
  if (obj == null || bound == null) return "-";
  const g = Math.abs(Number(bound) - Number(obj)) / Math.max(1, Math.abs(Number(obj)));
  return `${(g * 100).toFixed(1)}%`;
}

/** One event as a line of the text log (null: not logged). */
function describe(ev: Record<string, unknown>): string | null {
  const k = typeof ev.k === "number" ? ev.k : 0;
  const stage = `stage ${k + 1}`;
  const v = (x: unknown) => (x == null ? "-" : `${num(Number(x) * SCALE[k])} ${UNITS[k]}`);
  switch (ev.type) {
    case "meta": {
      const o = ev.options as SolveResult["options"];
      return `RUN ${ev.id} · ${ev.label || "run"} · ${ev.conflicts} conflicts · up to ${ev.stageSeconds}s per stage\n` +
        `options: delay<=${o.maxDelayDays}d early<=${o.maxEarlyDays}d moves<=${o.maxMoves} minSegment=${o.minSegmentDays}d ` +
        `weights delay=${o.weights.delay} early=${o.weights.early} move=${o.weights.move} (app timeLimitSec=${o.timeLimitSec})`;
    }
    case "start": {
      const c = ev.counts as Record<string, number>;
      return `input: ${c.conflicts} conflicts, ${c.berths} berths, ${c.berthBusy} fixed berth bookings, ${c.vesselBusy} fixed vessel bookings`;
    }
    case "stage":
      return `==== STAGE ${Number(ev.k) + 1}: ${STAGE_TITLES[Number(ev.k)]} (${ev.maximize ? "maximize" : "minimize"} ${ev.name}) ====`;
    case "solution":
      return `${stage}  t=${secs(ev.t)}  NEW BEST=${v(ev.obj)}  bound=${v(ev.bound)}  gap=${gap(ev.obj, ev.bound)}`;
    case "bound":
      return `${stage}  t=${secs(ev.t)}  bound -> ${v(ev.bound)}`;
    case "log":
      return String(ev.line).split("\n").map((l) => `  | ${l}`).join("\n");
    case "stageEnd":
      return `${stage} END after ${secs(ev.t)}: ${ev.status}${ev.stopped ? " (stopped by you)" : ""}  best=${v(ev.obj)}  bound=${v(ev.bound)}  gap=${gap(ev.obj, ev.bound)}`;
    case "result": {
      const r = ev.result as SolveResult;
      const s = r.stats;
      return `RESULT ${r.status}: placed ${s.placed} of ${s.considered} solvable (${s.unplaced} unplaced), ` +
        `${s.delayDays} delay days, ${s.moves} moves, ${s.slackFootDays} ft-days slack, solved in ${s.solveMs}ms`;
    }
    case "error":
      return `ERROR ${ev.message}`;
    case "end":
      return "RUN ENDED";
    default:
      return null;
  }
}

/** A finished run from an earlier session, read back from its file. */
function loadRun(id: string): Run | null {
  const file = join(RUNS, `${id}.ndjson`);
  if (!/^[\w-]+$/.test(id) || !existsSync(file)) return null;
  const events = readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (!events.some((e) => e.includes('"type":"end"'))) events.push(JSON.stringify({ type: "end", interrupted: true }));
  return { id, file, log: null, events, done: true, t0: 0, child: null, listeners: new Set() };
}

function listRuns() {
  return readdirSync(RUNS).filter((f) => f.endsWith(".ndjson")).sort().reverse().slice(0, 40).map((f) => {
    const first = readFileSync(join(RUNS, f), "utf8").split("\n", 1)[0];
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(first); } catch { /* a torn file: list it bare */ }
    return { id: f.replace(/\.ndjson$/, ""), label: meta.label ?? "", stageSeconds: meta.stageSeconds ?? null,
      conflicts: meta.conflicts ?? null, live: runs.get(f.replace(/\.ndjson$/, ""))?.child != null,
      bytes: statSync(join(RUNS, f)).size };
  });
}

// ── http ──

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;

  if (req.method === "GET" && (p === "/" || /^\/[\w.-]+\.(js|css|html)$/.test(p))) {
    const file = join(HERE, "public", p === "/" ? "index.html" : p.slice(1));
    if (!existsSync(file)) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    return createReadStream(file).pipe(res);
  }

  if (req.method === "GET" && p === "/api/projects") {
    const { rows } = await getDb().query(
      `SELECT p.id, p.name, p.template_key AS "templateKey",
         (SELECT count(*) FROM conflict c WHERE c.project_id = p.id AND c.status = 'open')::int AS "openConflicts",
         (SELECT count(*) FROM berth b WHERE b.project_id = p.id AND b.active AND b.kind = 'berth')::int AS berths
       FROM project p ORDER BY "openConflicts" DESC, p.created_at DESC LIMIT 60`);
    return json(res, 200, { projects: rows, defaults: SOLVE_DEFAULTS });
  }

  if (req.method === "GET" && p === "/api/runs") return json(res, 200, { runs: listRuns() });

  if (req.method === "POST" && p === "/api/runs") {
    const body = JSON.parse(await readBody(req)) as {
      projectId?: string; input?: SolverInput; options?: Partial<SolveResult["options"]>; stageSeconds?: number; label?: string;
    };
    const stageSeconds = Math.min(Math.max(Number(body.stageSeconds) || 60, 1), 3600);
    let input: SolverInput | null;
    if (body.projectId) {
      ({ input } = await buildSolverInput(body.projectId, { conflictIds: "all", options: body.options }));
      if (!input) return json(res, 400, { error: "That project has no open conflicts to solve." });
    } else if (body.input?.conflicts) {
      input = { ...body.input, options: { ...SOLVE_DEFAULTS, ...body.input.options, ...body.options,
        weights: { ...SOLVE_DEFAULTS.weights, ...body.input.options?.weights, ...body.options?.weights } } };
    } else {
      return json(res, 400, { error: "Pick a project or load a SolverInput JSON file." });
    }
    const run = startRun(input, stageSeconds, {
      label: body.label ?? "", projectId: body.projectId ?? null, conflicts: input.conflicts.length,
    });
    return json(res, 200, { id: run.id });
  }

  const m = p.match(/^\/api\/runs\/([\w-]+)\/(events|skip|stop)$/);
  if (m) {
    const run = runs.get(m[1]) ?? loadRun(m[1]);
    if (!run) return json(res, 404, { error: "no such run" });
    if (m[2] === "events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      // "now" on the run's clock, so the page can keep a live stage's lines moving between events
      res.write(`data: ${JSON.stringify({ type: "hello", live: !run.done, at: (performance.now() - run.t0) / 1000 })}\n\n`);
      for (const line of run.events) res.write(`data: ${line}\n\n`);
      if (run.done) return res.end();
      run.listeners.add(res);
      req.on("close", () => run.listeners.delete(res));
      return;
    }
    if (req.method === "POST" && (m[2] === "skip" || m[2] === "stop")) {
      if (!run.child) return json(res, 409, { error: "That run has finished." });
      run.child.stdin.write(`${m[2]}\n`);
      return json(res, 200, { ok: true });
    }
  }

  json(res, 404, { error: "not found" });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8") || "{}"));
    req.on("error", reject);
  });
}

createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    else res.end();
  });
}).listen(PORT, () => console.log(`CP-SAT monitor → http://localhost:${PORT}`));

process.on("exit", () => { for (const r of runs.values()) r.child?.kill("SIGKILL"); });
process.on("SIGINT", () => process.exit(0));
