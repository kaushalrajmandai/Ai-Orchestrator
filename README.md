# AI Orchestrator

A platform where multiple AI models collaborate sequentially to complete complex projects automatically — built for indie creators and small teams who use AI daily but don't write code.

> Define a goal in plain English. The platform breaks it into tasks, assigns each to the best-fit model, executes them one at a time, passes context between models, and delivers the results into a shared workspace.

See [`VISION.md`](./VISION.md) for the full product vision.

---

## Monorepo structure

```
AI-Orchestrator/
├── frontend/        Next.js 14 (App Router) + Tailwind + TypeScript + Clerk
├── api/             Node.js + Fastify + TypeScript + Prisma (main API)
├── orchestrator/    Python + FastAPI + SQLAlchemy (AI pipeline engine)
├── package.json     npm workspaces (frontend + api)
├── VISION.md        Product vision document
└── README.md
```

### Why three services?

| Service | Stack | Responsibility |
|---|---|---|
| `frontend` | Next.js | UI, auth pages, real-time pipeline dashboard |
| `api` | Fastify | Auth, users, projects, providers, billing, workspace, API gateway |
| `orchestrator` | FastAPI | AI pipeline execution, task routing, model calls, memory retrieval |

The Node API owns the database schema (via Prisma) and all user-facing concerns. The Python orchestrator connects to the **same** PostgreSQL database to run pipelines — Python is used here because the AI/ML ecosystem is Python-first. The two services communicate over internal HTTP, with a Redis/BullMQ queue between them (added in a later phase).

---

## Prerequisites

- **Node.js** ≥ 20
- **Python** ≥ 3.11
- **PostgreSQL** ≥ 14 with the [`pgvector`](https://github.com/pgvector/pgvector) extension available
- **Redis** (only needed from Phase 4 onward)
- A [Clerk](https://clerk.com) account (free tier) for authentication

---

## Environment setup

Each service has its own `.env.example`. Copy it to `.env` and fill in the values:

```bash
cp frontend/.env.example      frontend/.env.local
cp api/.env.example           api/.env
cp orchestrator/.env.example  orchestrator/.env
```

You will need:

- **Clerk keys** (publishable + secret) — from the Clerk dashboard. Used by both `frontend` and `api`.
- **`DATABASE_URL`** — a PostgreSQL connection string. The same database is used by both `api` and `orchestrator`.
- **`ENCRYPTION_KEY`** — for the `api`, generate one with `openssl rand -hex 32` (used to encrypt provider API keys).

---

## Running each service

Install root + workspace dependencies once from the repo root:

```bash
npm install
```

### 1. Database (Prisma)

From `api/`, generate the client and apply the schema:

```bash
cd api
npm run prisma:generate     # generate the Prisma client
npm run prisma:migrate       # create + apply the initial migration
```

> The schema enables the `pgvector` extension. Ensure your PostgreSQL instance has it installed (`CREATE EXTENSION vector;` is handled by the migration).

### 2. Frontend — http://localhost:3000

```bash
npm run dev:frontend
# or: cd frontend && npm run dev
```

### 3. API — http://localhost:4000

```bash
npm run dev:api
# or: cd api && npm run dev
```

Health check: `curl http://localhost:4000/health`

### 4. Orchestrator — http://localhost:8000

```bash
cd orchestrator
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Health check: `curl http://localhost:8000/health`
Interactive API docs: http://localhost:8000/docs

---

## Authentication flow

Auth is handled by **Clerk**:

- `frontend/src/middleware.ts` protects `/dashboard` — unauthenticated users are redirected to sign in.
- Sign-in / sign-up pages live at `/sign-in` and `/sign-up`.
- The `api` verifies Clerk session tokens via `@clerk/fastify`; routes opt into protection with the `requireAuth` preHandler (see `api/src/routes/me.ts`).

---

## Build order / roadmap

This repository is being built in layers. **Phase 1 (this foundation) is complete:**

- [x] **Phase 1 — Foundation:** monorepo, three services initialized, Prisma schema, Clerk auth, env templates
- [ ] Phase 2 — Provider system (encrypted API keys, managed tier, settings UI)
- [ ] Phase 3 — Project creation (CRUD + dashboard UI)
- [ ] Phase 4 — Orchestration engine (task breakdown, BullMQ queue, workers, retries, checkpoints)
- [ ] Phase 5 — Real-time pipeline dashboard (SSE/WebSocket, animated pipeline)
- [ ] Phase 6 — Workspace (R2 file storage)
- [ ] Phase 7 — Memory (pgvector embeddings, cross-project personalization)

---

## Database schema

Defined in [`api/prisma/schema.prisma`](./api/prisma/schema.prisma):

| Table | Purpose |
|---|---|
| `users` | Clerk-backed user records |
| `provider_keys` | Per-user AI provider keys (encrypted) or managed-tier flags |
| `projects` | A goal + chosen orchestrator model |
| `tasks` | Sequential pipeline tasks, each assigned to a model |
| `checkpoints` | Human-in-the-loop approval gates |
| `workspace_files` | Project outputs stored in Cloudflare R2 |
| `user_memory` | Cross-project preferences as `vector(1536)` embeddings (pgvector) |
