"""Direct HTTP calls to each AI provider.

We talk to the REST APIs with httpx instead of pulling in four vendor SDKs:
fewer dependencies, one consistent async path, and no SDK version churn. Every
call returns ``(text, tokens_used)`` and raises ``ProviderError`` on failure so
the pipeline can apply its retry / fallback logic uniformly.
"""

from __future__ import annotations

import re

import httpx

REQUEST_TIMEOUT = 120.0  # generation can be slow; keep a generous ceiling


class ProviderError(Exception):
    """Raised when a provider call fails (network, auth, or bad response)."""


class RateLimitError(ProviderError):
    """A 429 from a provider. ``retry_after`` is the suggested wait in seconds
    (None if the provider didn't say), so callers can back off and retry."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


def _parse_retry_after(resp: httpx.Response) -> float | None:
    """Extract a retry delay from a 429 response.

    Checks the standard Retry-After header first, then the Gemini-style
    RetryInfo / 'Please retry in 56.5s' message embedded in the JSON body.
    """
    header = resp.headers.get("retry-after")
    if header:
        try:
            return float(header)
        except ValueError:
            pass
    text = resp.text
    # Gemini: "...Please retry in 56.588330512s." or RetryInfo "retryDelay": "56s"
    match = re.search(r"retry(?:Delay)?[\"']?\s*[:in]*\s*\"?(\d+(?:\.\d+)?)s", text)
    if match:
        return float(match.group(1))
    return None


# The UI exposes friendly model ids (e.g. "claude-opus"). Map those to real API
# model ids. Unknown ids are passed through unchanged so callers can also supply
# a fully-qualified id directly.
MODEL_ALIASES: dict[str, str] = {
    "claude-opus": "claude-3-opus-latest",
    "claude-sonnet": "claude-3-5-sonnet-latest",
    "gpt-4o": "gpt-4o",
    "gpt-4o-mini": "gpt-4o-mini",
    # Gemini 1.5 is being retired; route legacy ids to a current free-tier model.
    "gemini-1.5-pro": "gemini-2.0-flash",
    "gemini-1.5-flash": "gemini-2.0-flash",
    "gemini-2.0-flash": "gemini-2.0-flash",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "deepseek-chat": "deepseek-chat",
}

# Sensible default model per provider, used when the orchestrator assigns a
# provider but no (or an unusable) model.
DEFAULT_MODELS: dict[str, str] = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-3-5-sonnet-latest",
    "gemini": "gemini-2.0-flash",
    "deepseek": "deepseek-chat",
}


def resolve_model(provider: str, model: str | None) -> str:
    """Translate a friendly/blank model id into a real API model id."""
    if not model:
        return DEFAULT_MODELS.get(provider, "")
    if model in MODEL_ALIASES:
        return MODEL_ALIASES[model]
    # Gemini 1.x (incl. "-latest" / "gemini-pro" variants) is retired and 404s.
    # Route anything from that family to the current default model.
    if provider == "gemini" and ("gemini-1." in model or model.startswith("gemini-pro")):
        return DEFAULT_MODELS["gemini"]
    return model


# Messages use the OpenAI shape everywhere: [{"role": "...", "content": "..."}].
# Each provider function adapts that into its own wire format.
Messages = list[dict[str, str]]


async def call_openai(model: str, messages: Messages, api_key: str) -> tuple[str, int]:
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        resp = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": model, "messages": messages},
        )
    if resp.status_code == 429:
        raise RateLimitError(
            f"OpenAI 429: {resp.text[:300]}", _parse_retry_after(resp)
        )
    if resp.status_code != 200:
        raise ProviderError(f"OpenAI {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    text = data["choices"][0]["message"]["content"]
    tokens = data.get("usage", {}).get("total_tokens", 0)
    return text, tokens


async def call_anthropic(
    model: str, messages: Messages, api_key: str
) -> tuple[str, int]:
    # Anthropic takes the system prompt as a top-level field, not a message.
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    convo = [m for m in messages if m["role"] != "system"]

    payload: dict = {"model": model, "max_tokens": 4096, "messages": convo}
    if system:
        payload["system"] = system

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
        )
    if resp.status_code == 429:
        raise RateLimitError(
            f"Anthropic 429: {resp.text[:300]}", _parse_retry_after(resp)
        )
    if resp.status_code != 200:
        raise ProviderError(f"Anthropic {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    text = "".join(
        block.get("text", "") for block in data.get("content", []) if block.get("type") == "text"
    )
    usage = data.get("usage", {})
    tokens = usage.get("input_tokens", 0) + usage.get("output_tokens", 0)
    return text, tokens


async def call_gemini(model: str, messages: Messages, api_key: str) -> tuple[str, int]:
    # Gemini separates the system instruction and uses "contents" with parts.
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    contents = [
        {
            # Gemini roles are "user" / "model".
            "role": "model" if m["role"] == "assistant" else "user",
            "parts": [{"text": m["content"]}],
        }
        for m in messages
        if m["role"] != "system"
    ]

    payload: dict = {"contents": contents}
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    )
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        resp = await client.post(
            url, params={"key": api_key}, json=payload
        )
    if resp.status_code == 429:
        raise RateLimitError(
            f"Gemini 429: {resp.text[:300]}", _parse_retry_after(resp)
        )
    if resp.status_code != 200:
        raise ProviderError(f"Gemini {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    try:
        parts = data["candidates"][0]["content"]["parts"]
        text = "".join(p.get("text", "") for p in parts)
    except (KeyError, IndexError) as exc:
        raise ProviderError(f"Gemini returned no content: {resp.text[:300]}") from exc
    tokens = data.get("usageMetadata", {}).get("totalTokenCount", 0)
    return text, tokens


async def call_deepseek(
    model: str, messages: Messages, api_key: str
) -> tuple[str, int]:
    # DeepSeek is OpenAI-compatible.
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        resp = await client.post(
            "https://api.deepseek.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": model, "messages": messages},
        )
    if resp.status_code == 429:
        raise RateLimitError(
            f"DeepSeek 429: {resp.text[:300]}", _parse_retry_after(resp)
        )
    if resp.status_code != 200:
        raise ProviderError(f"DeepSeek {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    text = data["choices"][0]["message"]["content"]
    tokens = data.get("usage", {}).get("total_tokens", 0)
    return text, tokens


async def call_provider(
    provider: str, model: str | None, messages: Messages, api_key: str
) -> tuple[str, int]:
    """Dispatch to the right provider, resolving the model id first."""
    resolved = resolve_model(provider, model)
    if provider == "openai":
        return await call_openai(resolved, messages, api_key)
    if provider == "anthropic":
        return await call_anthropic(resolved, messages, api_key)
    if provider == "gemini":
        return await call_gemini(resolved, messages, api_key)
    if provider == "deepseek":
        return await call_deepseek(resolved, messages, api_key)
    raise ProviderError(f"Unknown provider: {provider}")
