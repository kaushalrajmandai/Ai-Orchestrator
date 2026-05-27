"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { AVAILABLE_MODELS } from "@/lib/models";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// Default selection: first model of the first provider group.
const DEFAULT_MODEL = AVAILABLE_MODELS[0].models[0].id;

export default function NewProjectPage() {
  const router = useRouter();
  const { getToken } = useAuth();

  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    // Resolve which provider owns the chosen model.
    const group = AVAILABLE_MODELS.find((g) =>
      g.models.some((m) => m.id === model),
    );
    if (!group) {
      setError("Please select a valid orchestrator model.");
      setSubmitting(false);
      return;
    }

    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name,
          goal,
          orchestratorProvider: group.provider,
          orchestratorModel: model,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Failed to create project (${res.status})`);
      }
      router.push("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create project");
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <div className="mx-auto max-w-2xl">
        <Link
          href="/dashboard"
          className="mb-6 inline-block text-sm text-neutral-400 hover:text-white"
        >
          ← Back to dashboard
        </Link>

        <h1 className="mb-2 text-2xl font-bold">New Project</h1>
        <p className="mb-8 text-neutral-400">
          Give your project a goal and pick the orchestrator model that will
          coordinate the work.
        </p>

        {error && (
          <div className="mb-6 rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="mb-1 block text-sm text-neutral-400">
              Project name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Mumbai local horror game"
              className="w-full rounded-md border border-neutral-800 bg-neutral-900 p-2.5 outline-none focus:border-neutral-600"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-neutral-400">Goal</label>
            <p className="mb-2 text-xs text-neutral-500">
              Describe what you want to achieve. This is the main input — be as
              detailed as you like.
            </p>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              required
              rows={10}
              placeholder="Build a Mumbai local horror game with a story, visual asset prompts, game code, and QA testing…"
              className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-900 p-3 text-base leading-relaxed outline-none focus:border-neutral-600"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-neutral-400">
              Orchestrator model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-md border border-neutral-800 bg-neutral-900 p-2.5 outline-none focus:border-neutral-600"
            >
              {AVAILABLE_MODELS.map((group) => (
                <optgroup key={group.provider} label={group.label}>
                  {group.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {group.label} · {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-white px-5 py-2.5 font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create Project"}
          </button>
        </form>
      </div>
    </main>
  );
}
