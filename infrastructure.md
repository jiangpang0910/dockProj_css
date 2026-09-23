# Infrastructure

How the app is hosted, how a visitor gets a project, and how to run and reset it. It all fits in free tiers (the optional model step costs fractions of a cent per seed):
**$0/month**.

## 1. Shape

```
  Browser ──HTTPS──►  Vercel (one Next.js app)                          Neon (Postgres 16)
                      ├─ pages      /, /login, /p/[projectId]/…          ├─ main branch  ← production
                      ├─ /api/**    route handlers (Node runtime) ──TCP──►│   pooled URL (PgBouncer)
                      │             parse (zod) → rules.ts → SQL          └─ dev branch   ← previews + local dev
                      └─ cron  /api/cron/cleanup  (daily)
                              │
                              └─ POST /api/parse ──► Vercel project #2: pipeline/ (Python)  ──► Claude Haiku (optional,
                                 (x-parser-secret)      xlsx → ParsedWorkbook JSON              only unclassifiable cells)
```

| Piece | Choice | Why |
|---|---|---|
| App + API | **Vercel, Hobby tier** | one deploy for UI and API; pushing to `main` deploys; every PR gets a preview URL |
| Database | **Neon, free tier** | managed Postgres with `btree_gist`; branching gives a dev copy for free; suspends when idle |
| Runtime | Node (not Edge) for every `/api` route | `pg` and `exceljs` need Node APIs: `export const runtime = "nodejs"` |
| Auth | handed-out logins | username + password from `AUTH_ACCOUNTS`, a signed cookie, roles admin/editor/viewer (§5) |

Things this rules out on purpose: Docker, a separate API server, Redis, and anything a reviewer must install.

## 2. What a visitor sees

```
  /  (landing)
  └─ redirect ──►  /p/<workspace id>      the WHOI dock, seeded from the workbook, viewed as of 1 Jul 2019
```

There is nothing to choose: one workspace, shared by everyone who can sign in. It is created by `npm run db:seed`,
not by the app, and the app cannot delete or duplicate it.

**Everyone shares one copy.** The workspace is the seeded `sample` project itself, not a clone of it — cancel a
booking and the next person sees it gone. That is the point: it is one facility's schedule, not a sandbox each. The
only way back to a clean slate is `npm run db:seed -- --force`, which rebuilds it from the workbook.

## 3. Environments and secrets

| Env var | Where | Value |
|---|---|---|
| `DATABASE_URL` | Vercel (Production → Neon `main`, Preview → Neon `dev`), `.env.local` | Neon **pooled** URL (host contains `-pooler`), `?sslmode=require` |
| `DATABASE_URL_UNPOOLED` | laptop / CI only | Neon **direct** URL, for migrations and seeding |
| `CRON_SECRET` | Vercel | random string; Vercel Cron sends it as `Authorization: Bearer …` |
| `AUTH_SECRET` | Vercel, `.env.local` | `openssl rand -base64 32`; signs the session cookie. Rotating it signs everyone out |
| `AUTH_ACCOUNTS` | Vercel, `.env.local` | JSON list of logins: `[{"user":"admin","password":"…","role":"admin"}, …]`. Roles: `admin`, `editor`, `viewer` (§5) |
| `PARSER_URL`, `PARSER_SECRET` | Vercel (app) | the parser project's URL + a shared secret. Unset locally → the app spawns `python3 -m pipeline.cli` |
| `SOLVER_URL` (optional) | Vercel (app) | where `/api/solve` (CP-SAT) lives; defaults to `PARSER_URL` (same pipeline project, same secret). Unset locally → the app spawns `python3 -m pipeline.solve_cli`. OR-Tools makes that project ~178 MB unpacked (limit 250) |
| `PARSER_SECRET`, `ANTHROPIC_API_KEY` | Vercel (parser project) | the key is optional: without it the model step is skipped |

- **Local dev:** `vercel env pull .env.local`, then `npm run dev`, pointing at the Neon `dev` branch.
- **Tests:** they don't need Neon at all. `rules.ts` is pure, and the schema tests run Postgres in-process with PGlite.

### Connection handling (serverless + Postgres)

- **One `pg.Pool` per function instance,** created at module scope with `max: 3`. Warm invocations reuse it.
- **Always use the pooled URL.** Neon's PgBouncer multiplexes many short-lived function instances onto a few real connections.
- **Transaction-mode pooling allows no session state across transactions.** That rules out `SET` and session-level
  prepared statements. What we use is fine:
  - node-postgres sends unnamed statements.
  - `clone_project`'s temp tables live inside one statement.
  - The seed's commit is a single `BEGIN … COMMIT`.
- **Type parsers are set once at startup:** `1082 date → string`, `1700 numeric → number`. See database.md §8.

## 4. Deploy, migrate, seed

```
git push main ──► Vercel builds + deploys (automatic)

# schema changes: run BEFORE pushing code that needs them
DATABASE_URL_UNPOOLED=… npm run db:migrate        # applies db/migrations/*.sql in order, records each in schema_migration

# templates: once per database, or again to refresh
DATABASE_URL_UNPOOLED=… npm run db:seed           # idempotent; --force rebuilds the templates
```

`db:seed` builds the two template projects:

| Template | Built from |
|---|---|
| `defaults` | `backend/seed/defaults.json` (regex-extracted from the workbook): 8 berths/sections, 164 vessels |
| `sample` | clone of `defaults`, then `sample_data/Dock Schedule - Synthetic Sample.xlsx` run through **the real importer** (preview → commit), then `as_of_date = 2013-06-19`, the month whose next twelve hold every kind of conflict. **This is the workspace** |

Seeding through the real importer is also an end-to-end test: if the parser breaks, the seed fails.

## 5. Logins: what protects a project

There is no sign-up. You hand out a username and password (one per person or per group), and everyone on the same
login shares one set of projects. That keeps "fifty reviewers" from meaning "fifty project states".

- **Accounts** live in `AUTH_ACCOUNTS` (§3), parsed by `src/server/auth/accounts.ts`. Adding one is a redeploy.
  Passwords are plain text in that env var: fine for handed-out demo logins, not for real users.
- **Session = a signed cookie** (`dock.session`, HS256 JWT holding only the username, 30 days, httpOnly). Nothing is
  stored server-side. The role is looked up in `AUTH_ACCOUNTS` on every request, so removing an account or changing its
  role takes effect immediately. `src/server/auth/session.ts`.
- **Pages:** `src/proxy.ts` redirects `/` and `/p/*` to `/login` without a cookie. That's the optimistic check.
- **API:** every route goes through `route()` (`src/server/http/route.ts`), which is where the real check lives:
  no session → 401; a write from a `viewer` → 403; a `/api/projects/:pid` route → the project must be the caller's
  (`project.owner`) or the caller an admin → else 403. Templates are readable by anyone and writable by no one.
- **Roles:** `viewer` reads its own projects; `editor` reads and writes its own; `admin` reads and writes every
  account's (the landing page lists them all, with an owner chip).
- **`project.owner`** is the username that created it (migration 0008). Projects from before logins have `owner NULL`:
  only admins see them, and the idle cleanup removes them.
- Login and logout are server actions in `src/app/login/actions.ts`.

### Cleanup and abuse bounds

A daily Vercel Cron (the Hobby tier allows one run a day) calls `GET /api/cron/cleanup`. The route checks `CRON_SECRET`.

```sql
DELETE FROM project WHERE template_key IS NULL AND last_opened_at < now() - interval '14 days';
```

- `last_opened_at` is bumped by `GET /api/projects/:id`, which runs once per page load. It's not bumped per request.
- **Hard cap: 300 user projects.** `POST /api/projects` beyond it returns 503 *"Demo is full — try again tomorrow"*.
  A clone of the sample is ~2 MB, so 300 × 2 MB stays inside Neon's 0.5 GB with room for the templates.

## 6. Limits worth knowing

| Limit | Value | What it means here |
|---|---|---|
| Vercel request body | 4.5 MB | nothing is uploaded; the workbook (0.4 MB) is read by the seed, off the request path |
| Vercel function duration | `export const maxDuration = 60` on the solve route | parsing the sample takes a few seconds; the others finish in milliseconds |
| Neon idle suspend | ~5 min | the **first** request after idle waits ~0.5–1 s while the DB wakes; later ones are fast. The landing page is static, so it never waits |
| Neon storage | 0.5 GB | see the cap above |
| Vercel Cron (Hobby) | once a day | fine for cleanup |

## 7. Runbook

| Situation | Do |
|---|---|
| Workspace looks wrong / parser changed | `npm run db:seed -- --force`. It rebuilds the workspace from the workbook and discards whatever was edited into it |
| Need a clean dev database | delete and recreate the Neon `dev` branch from `main`, run `db:migrate` + `db:seed` |
| Demo full (503s) | run the cleanup early (`curl -H "Authorization: Bearer $CRON_SECRET" …/api/cron/cleanup`) or raise the cap |
| DB unreachable | the UI shows the `ApiError` with retry. Check Neon status; nothing to redeploy |

## 8. Cost

| Service | Tier | $ |
|---|---|---|
| Vercel | Hobby (2 projects: app + parser) | 0 |
| Anthropic API | pay-as-you-go, optional | ≈ $0.001 per seed (Haiku, one batched call of leftover strings); $0 if unset |
| Neon | Free | 0 |
| Domain | none: `*.vercel.app` | 0 |
