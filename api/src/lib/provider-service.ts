// Provider connection tests. Each function makes the cheapest possible
// authenticated request to verify an API key is valid — typically a GET on
// the provider's model-list endpoint, which spends no tokens.
//
// All functions return a plain boolean and never throw: network errors,
// timeouts, and auth failures all resolve to `false`.

import type { Provider } from "@prisma/client";

const REQUEST_TIMEOUT_MS = 8000;

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

export async function testOpenAIConnection(key: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: timeoutSignal(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function testAnthropicConnection(key: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      signal: timeoutSignal(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function testGeminiConnection(key: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { signal: timeoutSignal() },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function testDeepSeekConnection(key: string): Promise<boolean> {
  try {
    // DeepSeek is OpenAI-compatible and exposes a /models endpoint.
    const res = await fetch("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: timeoutSignal(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Dispatches to the right test based on provider. Returns a result shape
// suitable for the API response.
export async function testProviderConnection(
  provider: Provider,
  key: string,
): Promise<{ success: boolean; error?: string }> {
  let ok = false;
  switch (provider) {
    case "openai":
      ok = await testOpenAIConnection(key);
      break;
    case "anthropic":
      ok = await testAnthropicConnection(key);
      break;
    case "gemini":
      ok = await testGeminiConnection(key);
      break;
    case "deepseek":
      ok = await testDeepSeekConnection(key);
      break;
  }

  return ok
    ? { success: true }
    : { success: false, error: "Invalid API key or provider unreachable." };
}
