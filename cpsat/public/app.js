// CP-SAT monitor page. Talks to cpsat/server.ts: /api/projects, /api/runs, /api/runs/:id/{events,skip,stop}.
"use strict";

const STAGE_INFO = {
  placed: { title: "Place as many as possible", unit: "placed", scale: 1, goal: "conflicts given a berth" },
  cost: { title: "Least disruption", unit: "pts", scale: 1, goal: "delay·w + early·w + moves·w" },
  slack: { title: "Tightest fit", unit: "ft·days", scale: 0.1, goal: "wasted berth length × days" },
  offRequested: { title: "Stay on requested berth", unit: "days off", scale: 1, goal: "days not on the asked-for berth" },
};
const STAGE_NAMES = Object.keys(STAGE_INFO);
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: fine */ } },
};

let S = null;          // the run on screen
let es = null;         // its event stream
let selected = 0;      // stage in the chart
let fileInput = null;  // a loaded SolverInput
let defaults = null;
let whatifTouched = false;

function freshState(id) {
  return {
    id, meta: null, counts: null, shares: [0.4, 0.3, 0.2, 1.0], startAt: null, live: false, clockAt: 0, clockClient: 0,
    stages: STAGE_NAMES.map((name, k) => ({ k, name, status: "waiting", at: null, maximize: k === 0, sols: [], bounds: [], end: null })),
    logs: [], logRendered: 0, result: null, error: null, ended: false,
  };
}

// ── setup panel ──

async function loadProjects() {
  const sel = $("project");
  try {
    const r = await fetch("/api/projects").then((r) => r.json());
    if (r.error) throw new Error(r.error);
    defaults = r.defaults;
    sel.innerHTML = r.projects.map((p) =>
      `<option value="${p.id}" ${p.openConflicts ? "" : "disabled"}>${esc(p.name)}${p.templateKey ? " (template)" : ""} · ${p.openConflicts}</option>`).join("");
    const last = store.get("cpsat.project");
    if (last && r.projects.some((p) => p.id === last && p.openConflicts)) sel.value = last;
    setOptions(defaults);
  } catch (e) {
    sel.innerHTML = `<option>Could not load projects</option>`;
    $("start-err").textContent = `Database: ${e.message}`;
  }
}

function setOptions(o) {
  for (const k of ["maxDelayDays", "maxEarlyDays", "maxMoves", "minSegmentDays"]) $(k).value = o[k];
  for (const k of ["delay", "early", "move"]) $(`w-${k}`).value = o.weights[k];
}

function readOptions() {
  const n = (id) => Number($(id).value);
  return {
    maxDelayDays: n("maxDelayDays"), maxEarlyDays: n("maxEarlyDays"), maxMoves: n("maxMoves"), minSegmentDays: n("minSegmentDays"),
    weights: { delay: n("w-delay"), early: n("w-early"), move: n("w-move") },
  };
}

$("project").addEventListener("change", () => { fileInput = null; $("file").value = ""; $("file-note").textContent = ""; });
$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    fileInput = JSON.parse(await f.text());
    if (!Array.isArray(fileInput.conflicts)) throw new Error("no conflicts array");
    $("file-note").textContent = `${fileInput.conflicts.length} conflicts, ${fileInput.berths?.length ?? 0} berths. Used instead of the project.`;
    if (fileInput.options) setOptions({ ...defaults, ...fileInput.options, weights: { ...defaults?.weights, ...fileInput.options.weights } });
  } catch (err) {
    fileInput = null;
    $("file-note").textContent = `Not a SolverInput: ${err.message}`;
  }
});

$("start").addEventListener("click", async () => {
  $("start-err").textContent = "";
  $("start").disabled = true;
  const projectId = $("project").value;
  const body = {
    options: readOptions(), stageSeconds: Number($("stageSeconds").value),
    ...(fileInput ? { input: fileInput, label: $("file").files[0]?.name ?? "file" }
      : { projectId, label: $("project").selectedOptions[0]?.textContent.replace(/ · \d+$/, "") ?? "" }),
  };
  if (!fileInput) store.set("cpsat.project", projectId);
  try {
    const r = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    whatifTouched = false;
    openRun(j.id);
    loadRuns();
  } catch (e) {
    $("start-err").textContent = e.message;
  } finally {
    $("start").disabled = false;
  }
});

async function loadRuns() {
  const { runs } = await fetch("/api/runs").then((r) => r.json()).catch(() => ({ runs: [] }));
  $("runs").innerHTML = runs.length ? runs.map((r) => `
    <li data-id="${r.id}" class="${S?.id === r.id ? "on" : ""}">
      <span>${esc(r.label || "run")}${r.live ? ' <span class="live">● live</span>' : ""}</span>
      <span class="muted">${fmtRunTime(r.id)} · ${r.conflicts ?? "?"}c · ${r.stageSeconds ?? "?"}s</span>
    </li>`).join("") : `<li class="muted">None yet</li>`;
}
$("runs").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) { whatifTouched = false; openRun(li.dataset.id); loadRuns(); }
});

// ── a run's events ──

function openRun(id) {
  es?.close();
  S = freshState(id);
  selected = 0;
  $("log").textContent = "";
  $("empty").hidden = true;
  $("run").hidden = false;
  history.replaceState(null, "", `#run=${id}`);
  es = new EventSource(`/api/runs/${id}/events`);
  es.onmessage = (m) => { onEvent(JSON.parse(m.data)); schedule(); };
  es.onerror = () => { if (S?.ended) es.close(); };
  schedule();
}

function onEvent(ev) {
  const st = ev.k != null ? S.stages[ev.k] : null;
  switch (ev.type) {
    case "hello": S.live = ev.live; S.clockAt = ev.at; S.clockClient = performance.now(); break;
    case "meta": S.meta = ev; break;
    case "start": S.counts = ev.counts; S.shares = ev.shares ?? S.shares; S.startAt = ev.at; break;
    case "stage":
      for (const s of S.stages) if (s.k < ev.k && s.status === "waiting") s.status = "skipped";
      Object.assign(st, { status: "running", at: ev.at, maximize: ev.maximize });
      if ($("follow").checked) selected = ev.k;
      S.logs.push({ line: `── Stage ${ev.k + 1} · ${STAGE_INFO[ev.name].title} ──`, cls: "stage-mark" });
      break;
    case "solution": st.sols.push({ t: ev.t, obj: ev.obj, bound: ev.bound }); st.bounds.push({ t: ev.t, b: ev.bound }); break;
    case "bound": st.bounds.push({ t: ev.t, b: ev.bound }); break;
    case "stageEnd":
      st.end = ev;
      st.status = ev.stopped ? "stopped" : ev.status === "OPTIMAL" ? "optimal" : ev.status === "FEASIBLE" ? "feasible" : "none";
      break;
    case "log": S.logs.push({ line: ev.line, cls: /^#(\d|Done|Model)/.test(ev.line) ? "imp" : "" }); break;
    case "result": S.result = ev.result; break;
    case "error": S.error = ev.message; S.logs.push({ line: `ERROR ${ev.message}`, cls: "" }); break;
    case "end":
      S.ended = true; S.live = false;
      if ($("follow").checked && !S.stages[selected].sols.length) selected = S.stages.findLast((s) => s.sols.length)?.k ?? selected;
      for (const s of S.stages) if (s.status === "waiting" || s.status === "running") s.status = s.status === "running" ? "stopped" : "skipped";
      es?.close();
      loadRuns();
      break;
  }
}

/** Seconds on the run's clock right now (live), or at its end. */
function runNow() {
  if (S.live) return S.clockAt + (performance.now() - S.clockClient) / 1000;
  return Math.max(0, ...S.stages.filter((s) => s.end).map((s) => s.at + s.end.t));
}
/** How long a stage has been running (or ran). */
function stageSpan(st) {
  if (st.end) return st.end.t;
  if (st.status === "running") return S.live ? Math.max(0, runNow() - st.at) : lastT(st);
  return 0;
}
const lastT = (st) => Math.max(0, ...st.sols.map((s) => s.t), ...st.bounds.map((b) => b.t));
const best = (st) => st.end?.obj ?? st.sols.at(-1)?.obj ?? null;
const bound = (st) => st.end?.bound ?? st.bounds.at(-1)?.b ?? null;
const disp = (st, v) => (v == null ? null : v * STAGE_INFO[st.name].scale);
function gapOf(st) {
  const o = best(st), b = bound(st);
  if (o == null || b == null) return null;
  return Math.abs(b - o) / Math.max(1, Math.abs(o));
}
/** When the stage first reached the answer it ended with. */
function tFinal(st) {
  const o = best(st);
  const hit = st.sols.find((s) => s.obj === o);
  return hit ? hit.t : null;
}

// ── render ──

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
}
setInterval(() => { if (S?.live) schedule(); }, 250);

function render() {
  if (!S) return;
  const running = S.stages.some((s) => s.status === "running");
  const pill = $("state-pill");
  const state = S.error ? "error" : !S.ended ? (S.live ? "running" : "idle") : S.stages.some((s) => s.status === "stopped") ? "stopped" : "done";
  pill.className = `pill ${state}`;
  pill.textContent = { error: "error", running: "running", idle: "loading", stopped: "finished (stopped early)", done: "finished" }[state];
  $("clock").textContent = S.startAt != null ? `${fmtS(runNow())}` : "";
  $("skip").disabled = $("stop").disabled = !(S.live && running);

  const m = S.meta;
  $("run-title").innerHTML = m ? `<b>${esc(m.label || "run")}</b> <span class="muted">· ${S.counts ? `${S.counts.conflicts} conflicts, ${S.counts.berths} berths, ${S.counts.berthBusy} fixed bookings` : "…"}
    · up to ${m.stageSeconds}s per stage · delay ≤${m.options.maxDelayDays}d, early ≤${m.options.maxEarlyDays}d, moves ≤${m.options.maxMoves}</span>` : "";

  renderStages();
  renderChart();
  renderAdvisor();
  renderResult();
  renderLog();
}

function renderStages() {
  $("stages").innerHTML = S.stages.map((st) => {
    const info = STAGE_INFO[st.name];
    const o = disp(st, best(st)), b = disp(st, bound(st)), g = gapOf(st), tf = tFinal(st);
    const label = { waiting: "waiting", running: "running", optimal: "✓ optimal", feasible: "hit the cap", stopped: "stopped by you", skipped: "skipped", none: "no answer" }[st.status];
    return `<div class="stage ${selected === st.k ? "sel" : ""}" data-k="${st.k}">
      <div class="n">Stage ${st.k + 1}</div><div class="status ${st.status}">${label}</div>
      <div class="name">${info.title}</div><div class="goal">${info.goal}</div>
      <div class="big">${o == null ? "–" : fmtV(o)} <small>${info.unit}</small></div>
      <div class="row"><span>bound ${b == null ? "–" : fmtV(b)}</span><span>gap ${g == null ? "–" : fmtPct(g)}</span></div>
      <div class="row"><span>final answer at ${tf == null ? "–" : fmtS(tf)}</span><span>ran ${st.at == null ? "–" : fmtS(stageSpan(st))}</span></div>
      <div class="row"><span>${st.sols.length} improvement${st.sols.length === 1 ? "" : "s"}</span></div>
      <div class="gapbar"><i style="width:${g == null ? 0 : Math.max(0, 100 - Math.min(100, g * 100))}%"></i></div>
    </div>`;
  }).join("");
}
$("stages").addEventListener("click", (e) => {
  const c = e.target.closest(".stage");
  if (!c) return;
  selected = Number(c.dataset.k);
  $("follow").checked = false;
  schedule();
});
for (const id of ["logx", "logy", "follow"]) $(id).addEventListener("change", schedule);

// ── chart ──

function renderChart() {
  const st = S.stages[selected];
  const info = STAGE_INFO[st.name];
  $("chart-title").textContent = `Stage ${st.k + 1} · ${info.title} (${info.unit}, ${st.maximize ? "higher" : "lower"} is better)`;
  const el = $("chart");
  const W = el.clientWidth, H = el.clientHeight;
  const P = { l: 58, r: 16, t: 12, b: 30 };
  if (!st.sols.length) {
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="none" x="${W / 2}" y="${H / 2}" text-anchor="middle">${
      { running: "Searching for a first answer…", waiting: "Not started yet.", skipped: "Skipped: nothing to optimize at this stage, or the run stopped first." }[st.status] ?? "Stopped before it found an answer."}</text></svg>`;
    return;
  }
  const logx = $("logx").checked, logy = $("logy").checked;
  const end = Math.max(stageSpan(st), lastT(st), 1e-3);
  const firstT = Math.min(...st.sols.map((s) => s.t), ...st.bounds.map((b) => b.t));
  const x0 = logx ? Math.max(1e-3, firstT * 0.7) : 0, x1 = end * (logx ? 1.3 : 1.03);
  const fx = logx ? (t) => Math.log10(Math.max(t, x0)) : (t) => t;
  const X = (t) => P.l + ((fx(t) - fx(x0)) / (fx(x1) - fx(x0))) * (W - P.l - P.r);

  const vals = [...st.sols.map((s) => disp(st, s.obj)), ...st.bounds.map((b) => disp(st, b.b))].filter(Number.isFinite);
  let y0 = Math.min(...vals), y1 = Math.max(...vals);
  const fy = logy ? (v) => Math.sign(v) * Math.log10(1 + Math.abs(v)) : (v) => v;
  let a = fy(y0), b = fy(y1);
  if (a === b) { a -= 1; b += 1; }
  const pad = (b - a) * 0.08; a -= pad; b += pad;
  const Y = (v) => P.t + (1 - (fy(v) - a) / (b - a)) * (H - P.t - P.b);

  // step lines
  const stepPath = (pts, tEnd) => {
    if (!pts.length) return "";
    let d = `M${X(pts[0].t)},${Y(pts[0].v)}`;
    for (let i = 1; i < pts.length; i++) d += `H${X(pts[i].t)}V${Y(pts[i].v)}`;
    return d + `H${X(tEnd)}`;
  };
  const bestPts = st.sols.map((s) => ({ t: s.t, v: disp(st, s.obj) }));
  const boundPts = [...st.bounds].sort((p, q) => p.t - q.t).map((p) => ({ t: p.t, v: disp(st, p.b) }));
  const dBest = stepPath(bestPts, end), dBound = stepPath(boundPts, end);
  // gap shading: sample both step functions on the union of their break points
  const ts = [...new Set([...bestPts, ...boundPts].map((p) => p.t))].sort((p, q) => p - q).filter((t) => t >= bestPts[0].t);
  ts.push(end);
  const at = (pts, t) => { let v = null; for (const p of pts) { if (p.t <= t) v = p.v; else break; } return v; };
  let area = "";
  if (boundPts.length) {
    const top = [], bot = [];
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i], tn = ts[i + 1] ?? t;
      const vb = at(bestPts, t), vo = at(boundPts, t) ?? vb;
      top.push(`${X(t)},${Y(vb)}`, `${X(tn)},${Y(vb)}`);
      bot.push(`${X(t)},${Y(vo)}`, `${X(tn)},${Y(vo)}`);
    }
    area = `<polygon fill="var(--gap)" points="${top.join(" ")} ${bot.reverse().join(" ")}"/>`;
  }

  // axes
  const yt = niceTicks(logy ? y0 : a, logy ? y1 : b, 5, logy);
  const xt = logx && Math.log10(x1 / x0) > 1.2 ? logTicks(x0, x1) : niceTicks(logx ? x0 : 0, x1, 6);
  const grid = yt.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/>`).join("");
  const yl = yt.map((v) => `<text x="${P.l - 8}" y="${Y(v) + 4}" text-anchor="end">${fmtV(v)}</text>`).join("");
  const xl = xt.filter((t) => t >= x0 && t <= x1).map((t) => `<text x="${X(t)}" y="${H - 10}" text-anchor="middle">${fmtS(t)}</text>`).join("");

  // markers
  const tf = tFinal(st);
  const lastLine = tf != null ? `<line x1="${X(tf)}" x2="${X(tf)}" y1="${P.t}" y2="${H - P.b}" stroke="var(--last)" stroke-dasharray="2 3" stroke-width="1.5"/>` : "";
  const cap = whatif()?.stages.find((s) => s.k === st.k)?.cap;
  const capLine = cap != null && cap >= x0 && cap <= x1
    ? `<line x1="${X(cap)}" x2="${X(cap)}" y1="${P.t}" y2="${H - P.b}" stroke="var(--cap)" stroke-dasharray="5 4" stroke-width="1.5"/>
       <text x="${X(cap) + 4}" y="${P.t + 12}" fill="var(--cap)" font-size="11">cap ${fmtS(cap)}</text>` : "";
  const dots = bestPts.map((p) => `<circle cx="${X(p.t)}" cy="${Y(p.v)}" r="2.6" fill="var(--best)"/>`).join("");

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    <g class="grid">${grid}</g>
    ${area}
    <path d="${dBound}" fill="none" stroke="var(--bound)" stroke-width="1.6" stroke-dasharray="5 4"/>
    <path d="${dBest}" fill="none" stroke="var(--best)" stroke-width="2.2"/>
    ${dots}${lastLine}${capLine}
    <g class="axis">${yl}${xl}</g>
    <line id="xh" y1="${P.t}" y2="${H - P.b}" stroke="var(--muted)" stroke-width="1" opacity="0"/>
    <rect x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent" id="hit"/>
  </svg>`;

  const hit = el.querySelector("#hit"), xh = el.querySelector("#xh"), tip = $("tip");
  const inv = (px) => {
    const f = fx(x0) + ((px - P.l) / (W - P.l - P.r)) * (fx(x1) - fx(x0));
    return logx ? 10 ** f : f;
  };
  hit.addEventListener("mousemove", (e) => {
    const r = el.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = inv(px);
    const vb = at(bestPts, t), vo = at(boundPts, t);
    xh.setAttribute("x1", px); xh.setAttribute("x2", px); xh.setAttribute("opacity", 0.5);
    tip.hidden = false;
    tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 14}px`;
    const g = vb != null && vo != null ? (Math.abs(vo - vb) / info.scale) / Math.max(1, Math.abs(vb) / info.scale) : null;
    tip.innerHTML = `<b>${fmtS(t)}</b> into the stage<br>best ${vb == null ? "none yet" : fmtV(vb)} · bound ${vo == null ? "–" : fmtV(vo)}${g == null ? "" : ` · gap ${fmtPct(g)}`}`;
  });
  hit.addEventListener("mouseleave", () => { tip.hidden = true; xh.setAttribute("opacity", 0); });
}

function niceTicks(lo, hi, n, symlog = false) {
  if (symlog) {
    const out = [lo, hi];
    for (let e = 0; 10 ** e <= Math.abs(hi) * 1.01; e++) if (10 ** e > lo && 10 ** e < hi) out.push(10 ** e);
    return [...new Set(out.map((v) => Math.round(v * 100) / 100))];
  }
  const span = hi - lo || 1;
  const step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}
function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const m of [1, 2, 5]) out.push(m * 10 ** e);
  return out;
}

// ── time-limit advisor ──

/** The stages that actually ran, with what the advisor needs from each. */
function ranStages() {
  return S.stages.filter((s) => s.at != null && s.sols.length).map((s) => ({
    k: s.k, st: s, share: S.shares[s.k], final: best(s), tFinal: tFinal(s), ran: stageSpan(s),
    proofT: s.status === "optimal" ? s.end.t : null,
  }));
}
/** Seconds between solve() starting and stage 1's search starting: model building counts against the deadline. */
function buildTime() {
  const s0 = S.stages.find((s) => s.at != null);
  return s0 && S.startAt != null ? Math.max(0, s0.at - S.startAt) : 0;
}

/**
 * Replays this run as if production had run it with timeLimitSec = T: each stage gets its share of the time left
 * (pipeline/docksolve STAGE_SHARE), stops at its cap or at its proof, and ends with its best answer by then.
 */
function simulate(T, ran = ranStages()) {
  let elapsed = buildTime();
  const out = [];
  let ok = true, proven = true, cutAt = null;
  for (let i = 0; i < ran.length; i++) {
    const r = ran[i];
    const left = T - elapsed;
    if (i > 0 && left <= 0.05) { cutAt = r.k; ok = false; proven = false; break; }
    const cap = Math.max(left * r.share, 0.2);
    const sol = [...r.st.sols].reverse().find((s) => s.t <= cap);
    if (!sol) { out.push({ k: r.k, cap, value: null, final: r.final, same: false }); ok = false; proven = false; cutAt = r.k + 1; break; }
    const done = r.proofT != null && r.proofT <= cap;
    const beyond = !done && cap > r.ran; // asks about time this run never watched
    out.push({ k: r.k, cap, value: sol.obj, final: r.final, same: sol.obj === r.final, proven: done, beyond });
    ok &&= sol.obj === r.final;
    proven &&= done;
    elapsed += done ? r.proofT : cap;
  }
  return { T, stages: out, ok, proven, cutAt };
}

function minT(pred, max = 3600) {
  const ran = ranStages();
  for (let T = 1; T <= max; T++) if (pred(simulate(T, ran))) return T;
  return null;
}

function whatif() {
  if (!S || !ranStages().length) return null;
  return simulate(Number($("whatif").value));
}

function renderAdvisor() {
  const ran = ranStages();
  const box = $("advice");
  if (!ran.length) {
    box.innerHTML = `<p class="muted">Needs at least one answer from the solver.</p>`;
    $("whatif-out").innerHTML = "";
    return;
  }
  const appT = S.meta?.options?.timeLimitSec ?? 10;
  const complete = S.ended;
  const tSame = minT((r) => r.ok && r.stages.length === ran.length);
  const tProof = ran.every((r) => r.proofT != null) ? minT((r) => r.proven && r.stages.length === ran.length) : null;
  const unsure = ran.filter((r) => r.proofT == null && r.tFinal != null && r.tFinal > r.ran * 0.75);
  const suggest = tSame == null ? null : Math.max(tSame + 2, Math.ceil(tSame * 1.5));
  const cores = navigator.hardwareConcurrency;

  const head = !complete
    ? `<p class="big-advice">Still running. The numbers below are for what's been seen so far.</p>`
    : suggest == null
      ? `<p class="big-advice">No time limit up to 3600 s gets this run's answer. A stage needed more than its share.</p>`
      : `<p class="big-advice">Suggested <code>timeLimitSec</code>: <b class="num">${suggest}</b> s
         <span class="muted">(app uses ${appT} s now)</span></p>
         <p class="note">The same answer as this run needs at least <b>${tSame} s</b>${tProof ? `, and proving every stage optimal needs <b>${tProof} s</b>` : ""}.
         The suggestion adds 50% headroom: CP-SAT with 8 workers is not deterministic, and a Vercel function may have fewer
         cores than this machine${cores ? ` (${cores})` : ""}.</p>`;

  const rows = S.stages.map((s) => {
    const r = ran.find((x) => x.k === s.k);
    const info = STAGE_INFO[s.name];
    if (!r) return `<tr><td>${s.k + 1}. ${info.title}</td><td class="r muted" colspan="4">${s.status === "skipped" ? "skipped" : s.status}</td><td></td></tr>`;
    const tag = s.status === "optimal" ? `<span class="tag ok">proven optimal</span>`
      : unsure.includes(r) ? `<span class="tag bad">still improving</span>`
      : `<span class="tag warn">not proven</span>`;
    return `<tr><td>${s.k + 1}. ${info.title}</td><td class="r">${fmtV(disp(s, r.final))} ${info.unit}</td>
      <td class="r">${r.tFinal == null ? "–" : fmtS(r.tFinal)}</td><td class="r">${r.proofT == null ? "–" : fmtS(r.proofT)}</td>
      <td class="r">${fmtS(r.ran)}</td><td>${tag}</td></tr>`;
  }).join("");

  box.innerHTML = `${head}
    <table><thead><tr><th>Stage</th><th class="r">Best</th><th class="r">Final answer at</th><th class="r">Proven at</th><th class="r">Ran</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="note">Model build before stage 1: ${fmtS(buildTime())}. It counts against the time limit too.
    ${unsure.length ? `<br><b>Stage ${unsure.map((r) => r.k + 1).join(", ")} was still improving when it stopped.</b> Its true best may be better; rerun with a bigger per-stage cap to see where it levels off.` : ""}
    <br>A what-if is a replay of this run: a stage cut shorter can hand the next stage a worse start than the replay assumes.</p>`;

  // what-if slider
  const slider = $("whatif");
  const maxT = Math.max(30, Math.ceil((buildTime() + ran.reduce((a, r) => a + r.ran, 0)) * 2.5), (suggest ?? 0) * 2);
  slider.max = Math.min(3600, maxT);
  if (!whatifTouched) slider.value = complete && suggest ? suggest : appT;
  $("whatif-v").textContent = slider.value;
  const w = whatif();
  const lines = S.stages.map((s) => {
    const info = STAGE_INFO[s.name];
    const r = w.stages.find((x) => x.k === s.k);
    const ranHere = ran.some((x) => x.k === s.k);
    if (!ranHere) return "";
    if (!r) return `<tr><td>${s.k + 1}. ${info.title}</td><td class="r muted" colspan="2">never starts: the time ran out</td><td><span class="tag bad">lost</span></td></tr>`;
    if (r.value == null) return `<tr><td>${s.k + 1}. ${info.title}</td><td class="r">${fmtS(r.cap)}</td><td class="r muted">no answer yet at the cap</td><td><span class="tag bad">${s.k === 0 ? "NO_SOLUTION" : "stage fails"}</span></td></tr>`;
    return `<tr><td>${s.k + 1}. ${info.title}</td><td class="r">${fmtS(r.cap)}</td>
      <td class="r">${fmtV(disp(s, r.value))}${r.same ? "" : ` <span class="muted">vs ${fmtV(disp(s, r.final))}</span>`} ${info.unit}</td>
      <td>${r.same ? `<span class="tag ok">same answer${r.proven ? ", proven" : ""}</span>` : `<span class="tag warn">worse</span>`}${r.beyond ? ` <span class="muted small">(beyond what this run watched)</span>` : ""}</td></tr>`;
  }).join("");
  $("whatif-out").innerHTML = `<table><thead><tr><th>Stage</th><th class="r">Its cap</th><th class="r">Answer by then</th><th></th></tr></thead><tbody>${lines}</tbody></table>
    <p class="note">${w.ok && w.stages.length === ran.length ? `With ${w.T} s: the same answer as this run.` : `With ${w.T} s: a worse answer than this run.`}</p>`;
}
$("whatif").addEventListener("input", () => { whatifTouched = true; schedule(); });

// ── result + log ──

function renderResult() {
  const r = S.result;
  if (!r) { $("result").innerHTML = S.error ? `<span class="err">${esc(S.error)}</span>` : `<span class="muted">Appears when the run ends.</span>`; return; }
  const reasons = {};
  for (const u of r.unplaced) reasons[u.reason] = (reasons[u.reason] ?? 0) + 1;
  $("result").innerHTML = `<dl class="kv">
    <dt>Status</dt><dd>${r.status}</dd>
    <dt>Placed</dt><dd>${r.stats.placed} of ${r.stats.considered} solvable</dd>
    <dt>Unplaced</dt><dd>${r.stats.unplaced}</dd>
    ${Object.entries(reasons).map(([k, v]) => `<dt class="small">· ${k}</dt><dd class="small">${v}</dd>`).join("")}
    <dt>Delay days</dt><dd>${r.stats.delayDays}</dd>
    <dt>Moves (splits)</dt><dd>${r.stats.moves}</dd>
    <dt>Slack</dt><dd>${fmtV(r.stats.slackFootDays)} ft·days</dd>
    <dt>Solve time</dt><dd>${fmtS(r.stats.solveMs / 1000)}</dd>
  </dl>`;
}

function renderLog() {
  const pre = $("log");
  const only = $("log-progress").checked;
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
  const frag = document.createDocumentFragment();
  for (; S.logRendered < S.logs.length; S.logRendered++) {
    const l = S.logs[S.logRendered];
    if (only && !l.cls) continue;
    const span = document.createElement("span");
    if (l.cls) span.className = l.cls;
    span.textContent = l.line + "\n";
    frag.appendChild(span);
  }
  pre.appendChild(frag);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
$("log-progress").addEventListener("change", () => { if (S) { $("log").textContent = ""; S.logRendered = 0; schedule(); } });

// ── controls ──

for (const cmd of ["skip", "stop"]) {
  $(cmd).addEventListener("click", async () => {
    if (!S) return;
    $(cmd).disabled = true;
    await fetch(`/api/runs/${S.id}/${cmd}`, { method: "POST" });
  });
}
window.addEventListener("resize", schedule);

// ── format ──

function fmtS(s) {
  if (s == null || !Number.isFinite(s)) return "–";
  if (s < 0.01) return `${(s * 1000).toFixed(1)}ms`;
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s < 10 ? s.toFixed(2) : s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}
function fmtV(v) {
  if (v == null || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1);
}
const fmtPct = (g) => (g === 0 ? "0%" : g < 0.001 ? "<0.1%" : `${(g * 100).toFixed(g < 0.1 ? 1 : 0)}%`);
function fmtRunTime(id) {
  // ids are local date + time: 2026-09-22_12-13-56
  const [date, time = ""] = id.split("_");
  return `${date} ${time.split("-").slice(0, 2).join(":")}`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

loadProjects();
loadRuns();
const linked = location.hash.match(/^#run=([\w-]+)$/);
if (linked) openRun(linked[1]);
