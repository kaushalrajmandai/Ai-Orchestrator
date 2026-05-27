"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
  { value: "deepseek", label: "DeepSeek" },
] as const;

type ProviderValue = (typeof PROVIDERS)[number]["value"];

type ProviderKey = {
  id: string;
  provider: ProviderValue;
  isManagedMode: boolean;
  createdAt: string;
};

// Per-row live test result, keyed by provider key id.
type TestState = Record<string, "idle" | "testing" | "ok" | "fail">;

export default function ProvidersPage() {
  const { getToken } = useAuth();

  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<TestState>({});
  const [managedAvail, setManagedAvail] = useState<string[]>([]);

  // Form state
  const [provider, setProvider] = useState<ProviderValue>("openai");
  const [apiKey, setApiKey] = useState("");
  const [managed, setManaged] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Authenticated fetch helper — attaches the Clerk session token.
  const authFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const token = await getToken();
      return fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
      });
    },
    [getToken],
  );

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, managedRes] = await Promise.all([
        authFetch("/api/providers"),
        authFetch("/api/providers/managed"),
      ]);
      if (!res.ok) throw new Error(`Failed to load providers (${res.status})`);
      setKeys(await res.json());
      if (managedRes.ok) {
        const data = (await managedRes.json()) as { providers: string[] };
        setManagedAvail(data.providers ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load providers");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await authFetch("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          provider,
          key: managed ? undefined : apiKey,
          isManagedMode: managed,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Failed to add provider (${res.status})`);
      }
      setApiKey("");
      setManaged(false);
      await loadKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add provider");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      const res = await authFetch(`/api/providers/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        throw new Error(`Failed to delete (${res.status})`);
      }
      await loadKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete provider");
    }
  }

  async function handleTest(id: string) {
    setTests((t) => ({ ...t, [id]: "testing" }));
    try {
      const res = await authFetch(`/api/providers/${id}/test`, {
        method: "POST",
      });
      const data = await res.json();
      setTests((t) => ({ ...t, [id]: data.success ? "ok" : "fail" }));
    } catch {
      setTests((t) => ({ ...t, [id]: "fail" }));
    }
  }

  function statusBadge(id: string) {
    const state = tests[id] ?? "idle";
    if (state === "testing") return <span className="text-neutral-400">testing…</span>;
    if (state === "ok") return <span className="text-green-400">✓ connected</span>;
    if (state === "fail") return <span className="text-red-400">✗ not connected</span>;
    return <span className="text-neutral-500">not tested</span>;
  }

  const connectedProviders = new Set(keys.map((k) => k.provider));

  return (
    <main className="mx-auto min-h-screen max-w-2xl p-8">
      <Link
        href="/dashboard"
        className="mb-6 inline-block text-sm text-neutral-400 hover:text-white"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mb-2 text-2xl font-bold">AI Providers</h1>
      <p className="mb-8 text-neutral-400">
        Connect your AI provider keys (BYOK) or use managed mode where we supply
        the keys.
      </p>

      {error && (
        <div className="mb-6 rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Managed-mode availability — providers the platform supplies for you */}
      {managedAvail.length > 0 && (
        <div className="mb-6 rounded-md border border-green-900 bg-green-950/20 p-3 text-sm text-green-200">
          <span className="font-medium">Managed mode is on</span> for{" "}
          <span className="capitalize">{managedAvail.join(", ")}</span> — you can run
          pipelines with these providers without adding your own key. Connecting
          your own key below overrides the managed one.
        </div>
      )}

      {/* Connected providers */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">Connected</h2>
        {loading ? (
          <p className="text-neutral-500">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-neutral-500">No providers connected yet.</p>
        ) : (
          <ul className="space-y-2">
            {keys.map((k) => (
              <li
                key={k.id}
                className="flex items-center justify-between rounded-md border border-neutral-800 p-3"
              >
                <div>
                  <span className="font-medium capitalize">{k.provider}</span>
                  {k.isManagedMode && (
                    <span className="ml-2 rounded bg-blue-950 px-2 py-0.5 text-xs text-blue-300">
                      managed
                    </span>
                  )}
                  <div className="mt-1 text-xs">{statusBadge(k.id)}</div>
                </div>
                <div className="flex items-center gap-2">
                  {!k.isManagedMode && (
                    <button
                      onClick={() => handleTest(k.id)}
                      className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-900"
                    >
                      Test
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(k.id)}
                    className="rounded border border-red-900 px-3 py-1 text-sm text-red-300 hover:bg-red-950/40"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Add provider form */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Add provider</h2>
        <form onSubmit={handleAdd} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-neutral-400">Provider</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderValue)}
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 p-2"
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                  {connectedProviders.has(p.value) ? " (connected)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm text-neutral-400">API key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={managed}
              placeholder={managed ? "Not needed in managed mode" : "sk-…"}
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 p-2 disabled:opacity-40"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={managed}
              onChange={(e) => setManaged(e.target.checked)}
            />
            Use managed mode (we supply the key)
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-white px-5 py-2 font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save provider"}
          </button>
        </form>
      </section>
    </main>
  );
}
