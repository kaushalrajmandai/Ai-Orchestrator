"""FastAPI orchestration engine — the core of AI Orchestrator.

Phase 4. Given a project goal, an orchestrator AI breaks it into sequential
tasks; the engine then runs each task through its assigned provider, passing
accumulated context forward, pausing at human-approval checkpoints, and
retrying / failing over when a provider call errors.

Execution runs as an in-process asyncio background task. A Redis + BullMQ queue
is the eventual home for this (see VISION.md), but for a single sequential
pipeline an async task gives identical behaviour — one task at a time, with
checkpoint pause/resume — without the extra infrastructure. The pipeline talks
to the Node API only through the internal HTTP routes, so swapping in a real
queue later means moving `run_pipeline` behind a worker, nothing else.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re

import httpx
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from pydantic import BaseModel

from app.config import settings
from app.providers import (
    DEFAULT_MODELS,
    ProviderError,
    RateLimitError,
    call_provider,
    resolve_model,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("orchestrator")

app = FastAPI(
    title="AI Orchestrator — Orchestration Engine",
    description="Executes sequential AI pipelines for AI Orchestrator projects.",
    version="0.4.0",
)

VALID_PROVIDERS = {"openai", "anthropic", "gemini", "deepseek"}
CHECKPOINT_POLL_SECONDS = 2.0
CHECKPOINT_MAX_WAIT_SECONDS = 60 * 30  # give up waiting on approval after 30 min

# Rate-limit backoff. Free tiers (esp. Gemini) cap requests per minute; on a 429
# we wait the provider-suggested delay (capped) and retry instead of failing.
RATE_LIMIT_RETRIES = 2
RATE_LIMIT_DEFAULT_WAIT = 20.0  # used when the provider gives no retry hint
RATE_LIMIT_MAX_WAIT = 65.0  # don't wait on huge (e.g. per-day) quota delays
INTER_TASK_DELAY = 3.0  # brief pause between tasks to avoid bursting the limit


class ExecuteRequest(BaseModel):
    project_id: str
    goal: str
    orchestrator_provider: str
    orchestrator_model: str
    orchestrator_key: str
    user_id: str
    api_callback_url: str


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok", "service": "orchestrator"}


@app.post("/execute")
async def execute(
    req: ExecuteRequest,
    background_tasks: BackgroundTasks,
    x_internal_secret: str | None = Header(default=None),
) -> dict[str, bool]:
    """Validate the caller and launch the pipeline in the background."""
    if x_internal_secret != settings.internal_secret:
        raise HTTPException(status_code=401, detail="Invalid internal secret.")

    background_tasks.add_task(run_pipeline, req)
    return {"started": True}


# ---------------------------------------------------------------------------
# Internal API client — talks to the Node API's /api/internal/* routes.
# ---------------------------------------------------------------------------


def _headers() -> dict[str, str]:
    return {
        "x-internal-secret": settings.internal_secret,
        "Content-Type": "application/json",
    }


async def api_create_tasks(base: str, project_id: str, tasks: list[dict]) -> list[dict]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{base}/api/internal/tasks/create",
            headers=_headers(),
            json={"projectId": project_id, "tasks": tasks},
        )
    resp.raise_for_status()
    return resp.json()["tasks"]


async def api_update_task(base: str, task_id: str, **fields) -> None:
    async with httpx.AsyncClient(timeout=30.0) as client:
        await client.post(
            f"{base}/api/internal/tasks/{task_id}/update",
            headers=_headers(),
            json=fields,
        )


async def api_set_project_status(
    base: str, project_id: str, status: str, final_output: str | None = None
) -> None:
    payload: dict = {"status": status}
    if final_output is not None:
        payload["finalOutput"] = final_output
    async with httpx.AsyncClient(timeout=30.0) as client:
        await client.post(
            f"{base}/api/internal/projects/{project_id}/status",
            headers=_headers(),
            json=payload,
        )


async def api_create_checkpoint(base: str, project_id: str, task_id: str) -> str:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{base}/api/internal/checkpoints/create",
            headers=_headers(),
            json={"projectId": project_id, "taskId": task_id},
        )
    resp.raise_for_status()
    return resp.json()["id"]


async def api_get_checkpoint(base: str, checkpoint_id: str) -> dict:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{base}/api/internal/checkpoints/{checkpoint_id}", headers=_headers()
        )
    resp.raise_for_status()
    return resp.json()


async def api_get_keys(base: str, project_id: str) -> dict[str, str]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{base}/api/internal/projects/{project_id}/keys", headers=_headers()
        )
    resp.raise_for_status()
    return resp.json().get("keys", {})


# ---------------------------------------------------------------------------
# Goal breakdown — ask the orchestrator AI for a task plan as JSON.
# ---------------------------------------------------------------------------

BREAKDOWN_PROMPT = """You are a project manager AI. Break down this goal into 3-6 sequential tasks.
For each task specify: title, instruction, which AI provider should handle it,
and whether it needs human approval before continuing. Return ONLY a JSON array.

IMPORTANT: You may ONLY assign tasks to providers the user has connected:
{providers}. Do not use any provider outside this list. If only one provider is
available, assign every task to it. Leave "model" empty unless you are certain
of an exact, current model id for the chosen provider.

COST-AWARE ROUTING: When more than one provider is available, prefer cheaper,
faster providers (e.g. gemini, deepseek) for simple/mechanical steps such as
drafting, formatting, summarizing, or translating. Reserve stronger, more
expensive providers (e.g. openai, anthropic) for the genuinely hard steps that
need deep reasoning, nuanced judgement, or high-quality final writing. Spread
work across the available providers where it genuinely helps quality or cost.

Goal: {goal}

Return format:
[
  {{
    "title": "task title",
    "instruction": "detailed instruction for the AI",
    "provider": "one of: {providers}",
    "model": "",
    "needs_checkpoint": true
  }}
]"""

STRICTER_SUFFIX = (
    "\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY "
    "a raw JSON array — no markdown fences, no prose, no explanation. Start your "
    "response with '[' and end with ']'."
)


def _extract_json_array(text: str) -> list[dict]:
    """Pull a JSON array out of a model response that may include fences/prose."""
    # Strip ```json ... ``` fences if present.
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else text
    # Fall back to the outermost [ ... ] span.
    start, end = candidate.find("["), candidate.rfind("]")
    if start != -1 and end != -1 and end > start:
        candidate = candidate[start : end + 1]
    return json.loads(candidate)


def _normalize_tasks(
    raw: list[dict], available: list[str], default_provider: str
) -> list[dict]:
    """Coerce the model's plan into the shape the API expects.

    Any task assigned to a provider the user hasn't connected is remapped to the
    orchestrator's own provider (whose key we know works), and its model is
    cleared so the remapped provider's default is used instead of a foreign id.
    """
    tasks: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        provider = str(item.get("provider", "")).lower().strip()
        model = item.get("model")
        if provider not in available:
            # Unavailable (or invalid) provider — route to a provider we can run.
            provider = default_provider
            model = None  # drop any model id meant for the original provider
        model = model or DEFAULT_MODELS.get(provider)
        tasks.append(
            {
                "title": str(item.get("title", "")).strip() or "Untitled task",
                "instruction": str(item.get("instruction", "")).strip(),
                "provider": provider,
                "model": model,
                "needs_checkpoint": bool(item.get("needs_checkpoint", False)),
            }
        )
    return tasks


async def get_task_breakdown(req: ExecuteRequest, available: list[str]) -> list[dict]:
    """Call the orchestrator AI and return a normalized task plan.

    ``available`` is the set of providers the user has keys for; the orchestrator
    is told to assign only those, and any stray assignment is remapped to the
    orchestrator's provider. Retries once with a stricter prompt on bad JSON.
    """
    providers_str = ", ".join(available)
    prompt = BREAKDOWN_PROMPT.format(goal=req.goal, providers=providers_str)
    for attempt in range(2):
        messages = [{"role": "user", "content": prompt}]
        text, _ = await call_provider(
            req.orchestrator_provider,
            req.orchestrator_model,
            messages,
            req.orchestrator_key,
        )
        try:
            parsed = _extract_json_array(text)
            tasks = _normalize_tasks(parsed, available, req.orchestrator_provider)
            if tasks:
                return tasks
            raise ValueError("empty task list")
        except (json.JSONDecodeError, ValueError) as exc:
            log.warning("Breakdown parse failed (attempt %d): %s", attempt + 1, exc)
            prompt = (
                BREAKDOWN_PROMPT.format(goal=req.goal, providers=providers_str)
                + STRICTER_SUFFIX
            )
    raise ProviderError("Orchestrator AI did not return a valid task plan.")


# ---------------------------------------------------------------------------
# Task execution with retry + fallback.
# ---------------------------------------------------------------------------


def _build_messages(goal: str, prior_outputs: list[tuple[str, str]], instruction: str):
    """System + user messages giving the model the full project context."""
    context = [f"PROJECT GOAL:\n{goal}"]
    if prior_outputs:
        context.append("\nOUTPUTS FROM PREVIOUS TASKS:")
        for title, output in prior_outputs:
            context.append(f"\n--- {title} ---\n{output}")
    context.append(f"\nYOUR TASK:\n{instruction}")
    return [
        {
            "role": "system",
            "content": (
                "You are an expert AI specialist working as one step in a larger "
                "automated pipeline. Use the provided context and complete only "
                "your assigned task. Produce a clear, finished result."
            ),
        },
        {"role": "user", "content": "\n".join(context)},
    ]


async def synthesize_final(
    req: ExecuteRequest, prior_outputs: list[tuple[str, str]]
) -> str:
    """Compose the single clean deliverable the user actually asked for.

    Runs after all tasks finish. Intermediate task outputs often contain
    planning notes, critiques, or suggestions; this step distills them into the
    final artifact only — no commentary, headings, or meta-text.
    """
    context = [f"PROJECT GOAL:\n{req.goal}", "\nWORK PRODUCED BY THE PIPELINE:"]
    for title, output in prior_outputs:
        context.append(f"\n--- {title} ---\n{output}")
    messages = [
        {
            "role": "system",
            "content": (
                "You are assembling the final deliverable for a project. Using "
                "the goal and all the work produced, output ONLY the finished "
                "result the user asked for — the actual artifact itself. Do not "
                "include commentary, explanations, critiques, suggestions, "
                "headings like 'Final Result', or any preamble. If the work "
                "contains drafts and revision notes, apply the improvements and "
                "return the polished final version only."
            ),
        },
        {"role": "user", "content": "\n".join(context)},
    ]
    text, _ = await call_provider(
        req.orchestrator_provider,
        req.orchestrator_model,
        messages,
        req.orchestrator_key,
    )
    return text.strip()


async def _call_with_backoff(
    provider: str, model: str | None, messages: list[dict], key: str
) -> tuple[str, int]:
    """Call a provider, waiting and retrying on rate-limit (429) responses.

    Honors the provider's suggested retry delay when given (capped). A delay
    larger than the cap (e.g. a per-day quota) is treated as non-retryable.
    """
    last_exc: ProviderError | None = None
    for attempt in range(RATE_LIMIT_RETRIES + 1):
        try:
            return await call_provider(provider, model, messages, key)
        except RateLimitError as exc:
            last_exc = exc
            wait = exc.retry_after or RATE_LIMIT_DEFAULT_WAIT
            if wait > RATE_LIMIT_MAX_WAIT or attempt == RATE_LIMIT_RETRIES:
                # Quota won't free up soon enough, or we're out of retries.
                raise
            log.warning(
                "%s rate-limited; waiting %.0fs then retrying (attempt %d/%d)",
                provider, wait, attempt + 1, RATE_LIMIT_RETRIES,
            )
            await asyncio.sleep(wait)
        except ProviderError as exc:
            # Non-rate-limit errors aren't worth immediate retry here; the
            # caller handles fallback to another provider.
            raise exc
    assert last_exc is not None
    raise last_exc


async def _run_one_task(
    messages: list[dict],
    provider: str,
    model: str | None,
    keys: dict[str, str],
    req: ExecuteRequest,
) -> tuple[str, int, str, str]:
    """Run a single task with: try assigned (with 429 backoff), then fallback.

    Returns (output, tokens, used_provider, used_model). Raises ProviderError if
    every attempt fails.
    """
    # Pick a key for the assigned provider, falling back to the orchestrator key
    # when the provider happens to be the orchestrator's own provider.
    assigned_key = keys.get(provider)
    if not assigned_key and provider == req.orchestrator_provider:
        assigned_key = req.orchestrator_key

    # Attempt the assigned provider (with rate-limit backoff built in).
    if assigned_key:
        try:
            text, tokens = await _call_with_backoff(provider, model, messages, assigned_key)
            return text, tokens, provider, model or ""
        except ProviderError as exc:
            log.warning("Provider %s failed: %s", provider, exc)
    else:
        log.warning("No API key available for provider %s; going to fallback", provider)

    # Fallback: the orchestrator's provider/model, whose key we know is valid.
    # Run it whenever the resolved target differs from what just failed — this
    # covers the common case where the failed task used the same provider as the
    # orchestrator but a different (e.g. retired) model.
    fb_provider = req.orchestrator_provider
    fb_model = req.orchestrator_model
    primary_target = (provider, resolve_model(provider, model))
    fallback_target = (fb_provider, resolve_model(fb_provider, fb_model))
    if not assigned_key or fallback_target != primary_target:
        try:
            log.info("Falling back to %s (%s) for this task", fb_provider, fb_model)
            text, tokens = await _call_with_backoff(
                fb_provider, fb_model, messages, req.orchestrator_key
            )
            return text, tokens, fb_provider, fb_model
        except ProviderError as exc:
            log.error("Fallback provider %s also failed: %s", fb_provider, exc)

    raise ProviderError(f"Task failed on both {provider} and fallback {fb_provider}.")


async def _wait_for_checkpoint(base: str, checkpoint_id: str) -> str:
    """Poll until a checkpoint is approved/rejected. Returns final status."""
    waited = 0.0
    while waited < CHECKPOINT_MAX_WAIT_SECONDS:
        await asyncio.sleep(CHECKPOINT_POLL_SECONDS)
        waited += CHECKPOINT_POLL_SECONDS
        try:
            cp = await api_get_checkpoint(base, checkpoint_id)
        except Exception as exc:  # transient API hiccup — keep polling
            log.warning("Checkpoint poll error: %s", exc)
            continue
        if cp.get("status") in ("approved", "rejected"):
            return cp["status"]
    return "timeout"


# ---------------------------------------------------------------------------
# The pipeline.
# ---------------------------------------------------------------------------


async def run_pipeline(req: ExecuteRequest) -> None:
    base = req.api_callback_url

    # 0. Fetch the user's provider keys first so we know which providers can
    # actually run, and constrain the task plan to those.
    try:
        keys = await api_get_keys(base, req.project_id)
    except Exception as exc:
        log.error("Failed to fetch provider keys: %s", exc)
        keys = {}
    # The orchestrator's own provider is always usable (we hold its key).
    available = sorted({*keys.keys(), req.orchestrator_provider})
    log.info("Available providers for project %s: %s", req.project_id, available)

    # 1. Break the goal into a task plan limited to available providers.
    try:
        plan = await get_task_breakdown(req, available)
    except Exception as exc:
        log.error("Goal breakdown failed: %s", exc)
        # Surface the reason in the UI: record a single failed task so the
        # user sees *why* the pipeline failed instead of a bare "Failed".
        try:
            created = await api_create_tasks(
                base,
                req.project_id,
                [
                    {
                        "title": "Goal breakdown",
                        "instruction": "Break the project goal into tasks.",
                        "provider": req.orchestrator_provider,
                        "model": req.orchestrator_model,
                    }
                ],
            )
            await api_update_task(
                base,
                created[0]["id"],
                status="failed",
                output=(
                    "The orchestrator AI could not produce a task plan.\n\n"
                    f"{exc}"
                ),
            )
        except Exception as inner:
            log.error("Could not record breakdown failure: %s", inner)
        await api_set_project_status(base, req.project_id, "failed")
        return

    log.info("Project %s broken into %d tasks", req.project_id, len(plan))

    # 2. Persist the tasks (returns ids in sequence order).
    try:
        created = await api_create_tasks(base, req.project_id, plan)
    except Exception as exc:
        log.error("Failed to persist tasks: %s", exc)
        await api_set_project_status(base, req.project_id, "failed")
        return

    # 4. Execute tasks sequentially, threading context forward. (Provider keys
    # were already fetched in step 0.)
    prior_outputs: list[tuple[str, str]] = []
    pipeline_failed = False

    for index, (plan_task, db_task) in enumerate(zip(plan, created)):
        task_id = db_task["id"]
        provider = plan_task["provider"]
        model = plan_task["model"]

        # Space out calls so a burst doesn't trip free-tier per-minute limits.
        if index > 0:
            await asyncio.sleep(INTER_TASK_DELAY)

        await api_update_task(base, task_id, status="running")
        messages = _build_messages(req.goal, prior_outputs, plan_task["instruction"])

        try:
            output, tokens, used_provider, used_model = await _run_one_task(
                messages, provider, model, keys, req
            )
        except ProviderError as exc:
            log.error("Task '%s' failed: %s", plan_task["title"], exc)
            await api_update_task(
                base,
                task_id,
                status="failed",
                output=f"Task failed: {exc}",
            )
            pipeline_failed = True
            continue  # keep going with remaining tasks

        await api_update_task(
            base,
            task_id,
            status="completed",
            output=output,
            tokensUsed=tokens,
            assignedProvider=used_provider,
            assignedModel=used_model,
        )
        prior_outputs.append((plan_task["title"], output))

        # 5. Human-in-the-loop checkpoint: pause and wait for approval.
        if plan_task["needs_checkpoint"]:
            try:
                checkpoint_id = await api_create_checkpoint(base, req.project_id, task_id)
            except Exception as exc:
                log.error("Failed to create checkpoint: %s", exc)
                continue
            await api_set_project_status(base, req.project_id, "paused")
            log.info("Paused at checkpoint %s; awaiting approval", checkpoint_id)
            result = await _wait_for_checkpoint(base, checkpoint_id)
            if result == "approved":
                await api_set_project_status(base, req.project_id, "running")
                log.info("Checkpoint approved; resuming")
            else:
                log.warning("Checkpoint %s ended as '%s'; stopping pipeline", checkpoint_id, result)
                await api_set_project_status(base, req.project_id, "paused")
                return

    # 6. Compose the clean final deliverable from whatever completed, then set
    # status. We synthesize even on partial failure so a single broken step
    # never robs the user of a usable result.
    final_output: str | None = None
    if prior_outputs:
        try:
            final_output = await synthesize_final(req, prior_outputs)
        except Exception as exc:
            # Don't fail the whole run if synthesis errors — fall back to the
            # last completed task's output so the user still gets a deliverable.
            log.error("Final synthesis failed: %s", exc)
            final_output = prior_outputs[-1][1]

    final_status = "failed" if pipeline_failed else "completed"
    await api_set_project_status(
        base, req.project_id, final_status, final_output=final_output
    )
    log.info("Pipeline for project %s finished: %s", req.project_id, final_status)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=True)
