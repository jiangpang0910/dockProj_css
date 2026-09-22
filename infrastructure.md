# Infrastructure

How the app is hosted, how a visitor gets a project, and how to run and reset it. It all fits in free tiers (the optional model step costs fractions of a cent per upload):
**$0/month**.

## 1. Shape

```
  Browser ──HTTPS──►  Vercel (one Next.js app)                          Neon (Postgres 16)
                      ├─ pages      /, /new, /p/[projectId]/…            ├─ main branch  ← production
                      ├─ /api/**    route handlers (Node runtime) ──TCP──►│   pooled URL (PgBouncer)
                      │             parse (zod) → rules.ts → SQL          └─ dev branch   ← previews + local dev
                      ├─ /dock-template.xlsx   static file (public/)
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
  ├─ [ Open the sample ]  ──POST /api/projects {start:"sample"}──►  clone of the sample template  ──► /p/<id>
  │    "23 years of real-looking history from the WHOI workbook, viewed as of 1 Jul 2019"
  │
  ├─ [ New project ]  ──►  /new
  │     1. Name it
  │     2. Choose a starting point
  │        ○ Default fleet   — 6 berths + 2 shared sections + 164 vessels, no bookings  (clone of the defaults template)
  │        ○ Empty           — add berths and vessels by hand
  │        ○ Upload a spreadsheet
  │             • Our template   [Download dock-template.xlsx]  Berths / Vessels / Bookings sheets
  │             • Legacy grid    the year-per-sheet format of the original workbook
  │          → project is created empty, then the file goes through import preview → commit
  │     3. ──► /p/<id>
  │
  └─ Your projects  (ids remembered in this browser; "Copy link" to keep or share one)
```

**Every login gets its own copy of the sample.** The sample is a *template* project that is never edited. The first
"Open the sample" for an account clones it (`clone_project`, database.md §6), which takes under a second for ~2,100
bookings; later clicks reopen that same copy (`POST /api/projects/sample`). So a reviewer can cancel, move and break
things freely, and an account you hand to someone else still starts clean.

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
  - The import commit is a single `BEGIN … COMMIT`.
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
| `sample` | clone of `defaults`, then `sample_data/Dock Schedule - Synthetic Sample.xlsx` run through **the same importer the app uses** (preview → commit), then `as_of_date = 2019-07-01` so it opens on a busy summer |

Seeding the sample through the real importer is also an end-to-end test: if the importer breaks, the seed fails.

`public/dock-template.xlsx` is generated by `npm run template:build` (exceljs) and committed. It has:
- header rows;
- dropdowns for *Kind* and *Type*;
- one example row per sheet.

## 5. Logins: what protects a project

There is no sign-up. You hand out a username and password (one per person or per group), and everyone on the same
login shares one set of projects. That keeps "fifty reviewers" from meaning "fifty project states".

- **Accounts** live in `AUTH_ACCOUNTS` (§3), parsed by `src/server/auth/accounts.ts`. Adding one is a redeploy.
  Passwords are plain text in that env var: fine for handed-out demo logins, not for real users.
- **Session = a signed cookie** (`dock.session`, HS256 JWT holding only the username, 30 days, httpOnly). Nothing is
  stored server-side. The role is looked up in `AUTH_ACCOUNTS` on every request, so removing an account or changing its
  role takes effect immediately. `src/server/auth/session.ts`.
- **Pages:** `src/proxy.ts` redirects `/`, `/new` and `/p/*` to `/login` without a cookie. That's the optimistic check.
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
| Vercel request body | 4.5 MB | the sample workbook is 0.4 MB. The UI refuses files over 4 MB with a clear message before uploading |
| Vercel function duration | `export const maxDuration = 60` on the import and clone routes | parsing the sample takes a few seconds; the others finish in milliseconds |
| Neon idle suspend | ~5 min | the **first** request after idle waits ~0.5–1 s while the DB wakes; later ones are fast. The landing page is static, so it never waits |
| Neon storage | 0.5 GB | see the cap above |
| Vercel Cron (Hobby) | once a day | fine for cleanup |

## 7. Runbook

| Situation | Do |
|---|---|
| Sample looks wrong / importer changed | `npm run db:seed -- --force`. Existing clones are unaffected; new visitors get the new sample |
| Need a clean dev database | delete and recreate the Neon `dev` branch from `main`, run `db:migrate` + `db:seed` |
| Demo full (503s) | run the cleanup early (`curl -H "Authorization: Bearer $CRON_SECRET" …/api/cron/cleanup`) or raise the cap |
| DB unreachable | the UI shows the `ApiError` with retry. Check Neon status; nothing to redeploy |

## 8. Cost

| Service | Tier | $ |
|---|---|---|
| Vercel | Hobby (2 projects: app + parser) | 0 |
| Anthropic API | pay-as-you-go, optional | ≈ $0.001 per upload (Haiku, one batched call of leftover strings); $0 if unset |
| Neon | Free | 0 |
| Domain | none: `*.vercel.app` | 0 |
