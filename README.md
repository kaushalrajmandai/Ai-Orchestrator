# AI Orchestrator

> A no-code platform where multiple AI models collaborate on a single goal — one model breaks the goal into tasks, hands work between models, pauses for human approval at checkpoints, and assembles a final result. Give it a goal, get a finished multi-step project.

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Stack](https://img.shields.io/badge/stack-Next.js%20%C2%B7%20Fastify%20%C2%B7%20FastAPI%20%C2%B7%20Postgres-blue)

---

## Demo

<!-- ═══════════════════════════════════════════════════════════════════
     👇 DRAG & DROP YOUR DEMO VIDEO (.mp4) ONTO THE EMPTY LINE BELOW 👇
     GitHub uploads it and inserts a playable video automatically.
     After it appears, delete this comment block and the line below it.
     ═══════════════════════════════════════════════════════════════════ -->


_Demo video coming soon — drop the .mp4 on the empty line just above._

---

## What it does

You give the platform a goal (e.g. *"Write a poem about rain and translate it to Hindi"*). From there it runs autonomously:

1. An **orchestrator model** breaks the goal into 3–6 sequential tasks
2. Each task is routed to a provider and executed, with the **full context of previous tasks** passed forward
3. At any task marked as a **checkpoint**, the pipeline pauses and waits for your approval before continuing
4. A final **synthesis step** composes one clean deliverable from all the work
5. A **live dashboard** shows progress in real time — which model is running, task outputs, and the final result

If a provider fails or rate-limits, the engine **retries with backoff and falls back** to another available model, so a single failure doesn't kill the run.

---

## Architecture

Two backend services keep concerns separate: a Node API for everything user-facing, and a Python engine for AI execution (the AI/ML ecosystem is Python-first).

```
Next.js frontend  ──>  Fastify API (Node)  ──>  FastAPI orchestrator (Python)  ──>  AI providers
   (dashboard)          (auth, projects,          (task breakdown, sequential        (OpenAI, Anthropic,
                         keys, callbacks)           execution, fallback, synthesis)    Gemini, DeepSeek)
                              │                            │
                              └──────────  PostgreSQL  ────┘
                                          (Neon + pgvector)
```

| Layer | Tech | Role |
|---|---|---|
| Frontend | Next.js, Tailwind, TypeScript | Dashboard + live pipeline view |
| Main API | Node.js, Fastify, Prisma | Auth, projects, encrypted key storage, internal callbacks |
| Orchestration engine | Python, FastAPI, httpx | Task decomposition, sequential execution, routing, fallback, synthesis |
| Database | PostgreSQL (Neon) + pgvector | Projects, tasks, checkpoints, provider keys |
| Auth | Clerk | Sign-up, sessions, user management |

The Node API owns the schema (via Prisma); the Python service connects to the same database to run pipelines. The pipeline runs as an in-process async task (a Redis + BullMQ queue is the planned home for it at scale — identical behaviour for a single sequential pipeline).

---

## Key features

- **Sequential multi-model orchestration** — tasks routed across providers, context threaded forward
- **Human-in-the-loop checkpoints** — pause, review, approve before the pipeline continues
- **Adaptive fallback** — retry with backoff on rate limits, fail over to another provider
- **Cost-aware routing** — cheap models for simple steps, premium models reserved for hard ones
- **BYOK + managed mode** — bring your own provider keys, or run on platform-supplied keys
- **Encrypted key storage** — provider API keys encrypted at rest (AES-256-GCM)
- **Live pipeline dashboard** — watch tasks run, expand outputs, see the final deliverable

---

## Tech stack

`Next.js` · `TypeScript` · `Tailwind` · `Fastify` · `Prisma` · `Python` · `FastAPI` · `httpx` · `PostgreSQL` · `pgvector` · `Clerk` · `Neon`

---

## Running locally

**Prerequisites:** Node 20+, Python 3.11+, a PostgreSQL database with `pgvector` (e.g. [Neon](https://neon.tech)), and a [Clerk](https://clerk.com) app.

```bash
git clone https://github.com/kaushalrajmandai/Ai-Orchestrator.git
cd Ai-Orchestrator
npm install                       # installs frontend + api (npm workspaces)
```

**1. Environment** — copy each template and fill in the values:
```bash
cp frontend/.env.example     frontend/.env.local   # Clerk keys + NEXT_PUBLIC_API_URL
cp api/.env.example          api/.env              # Clerk keys, DATABASE_URL, ENCRYPTION_KEY, INTERNAL_SECRET
cp orchestrator/.env.example orchestrator/.env     # DATABASE_URL, INTERNAL_SECRET (must match the API)
```
Generate the API secrets with `openssl rand -hex 32` (ENCRYPTION_KEY) and `openssl rand -hex 24` (INTERNAL_SECRET).

**2. Database** (from `api/`):
```bash
cd api && npm run prisma:generate && npm run prisma:migrate && cd ..
```

**3. Run the three services** (separate terminals):
```bash
npm run dev:api          # http://localhost:4000
npm run dev:frontend     # http://localhost:3000

cd orchestrator && python3 -m venv .venv && source .venv/bin/activate \
  && pip install -r requirements.txt \
  && uvicorn app.main:app --reload --port 8000   # http://localhost:8000
```

Open http://localhost:3000, connect a provider key on the Providers page, create a project, and hit **Start Pipeline**.

---

## What I learned

This was my **first proper backend project** — and my first time using **Clerk** and **Neon**. I set out to build a product, and I came away with something more useful: a clear-eyed understanding of *why* this particular idea wouldn't fly as a business, plus a lot of hard-won engineering experience.

- **The technical win:** designing a two-service architecture, wiring a Node API to a Python engine, encrypting secrets at rest, and building real-time orchestration with checkpoints and fallback logic.
- **The real-world debugging:** API quota walls, rate limits and backoff, retired model IDs, provider routing, and secret-scanning — the failure modes taught me more than the happy path did.
- **The honest product lesson:** the "different AI models are specialists you route between" pitch was strong a couple of years ago, but frontier models have largely converged. The defensible value here is the **orchestration workflow and cost/resilience routing**, not the specialist-model claim. Recognizing when an idea has a thin moat — and saying so — is its own skill.

Sharing this as what it is: a substantial systems project I built end-to-end and learned a great deal from.

---

## License

[MIT](LICENSE) © 2026 Kaushal Rajmandai
