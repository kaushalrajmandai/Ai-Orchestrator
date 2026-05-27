"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { findModel } from "@/lib/models";
import { STATUS_STYLES, type ProjectStatus } from "@/lib/status";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type Task = {
  id: string;
  sequenceOrder: number;
  title: string;
  instruction: string;
  assignedProvider: string | null;
  assignedModel: string | null;
  status: string;
  output: string | null;
  tokensUsed: number;
  createdAt?: string;
  completedAt: string | null;
};

type Checkpoint = {
  id: string;
  taskId: string;
  status: string;
};

type Project = {
  id: string;
  name: string;
  goal: string;
  status: ProjectStatus;
  orchestratorProvider: string;
  orchestratorModel: string;
  finalOutput: string | null;
  createdAt: string;
  tasks: Task[];
  checkpoints?: Checkpoint[];
};

// Tailwind classes per task status.
const TASK_STATUS_STYLES: Record<string, string> = {
  pending: "bg-neutral-800 text-neutral-400",
  running: "bg-blue-950 text-blue-300",
  completed: "bg-green-950 text-green-300",
  failed: "bg-red-950 text-red-300",
  skipped: "bg-neutral-800 text-neutral-500",
};

function modelLabelFor(provider: string | null, model: string | null): string {
  if (!model) return provider ?? "—";
  const found = findModel(model);
  if (found) return `${found.providerLabel} · ${found.name}`;
  return `${provider ?? ""} · ${model}`.trim();
}

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const { getToken } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editingCheckpoint, setEditingCheckpoint] = useState<string | null>(null);
  const [editNotes, setEditNotes] = useState("");
  const [approving, setApproving] = useState(false);
  // null = follow default (open unless completed); true/false = user override.
  const [stepsOpen, setStepsOpen] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);

  const authedFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const token = await getToken();
      return fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      });
    },
    [getToken],
  );

  // Full project load (includes goal + orchestrator info).
  const loadProject = useCallback(async () => {
    try {
      const res = await authedFetch(`/api/projects/${params.id}`);
      if (res.status === 404) throw new Error("Project not found.");
      if (!res.ok) throw new Error(`Failed to load project (${res.status})`);
      setProject(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load project");
    } finally {
      setLoading(false);
    }
  }, [authedFetch, params.id]);

  // Lightweight status poll — merges tasks, status, and pending checkpoints.
  const pollStatus = useCallback(async () => {
    try {
      const res = await authedFetch(`/api/projects/${params.id}/status`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        status: ProjectStatus;
        finalOutput: string | null;
        tasks: Task[];
        checkpoints: Checkpoint[];
      };
      setProject((prev) =>
        prev
          ? {
              ...prev,
              status: data.status,
              finalOutput: data.finalOutput,
              tasks: data.tasks,
              checkpoints: data.checkpoints,
            }
          : prev,
      );
    } catch {
      // Ignore transient poll errors; next tick retries.
    }
  }, [authedFetch, params.id]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  // Poll every 3s while the pipeline is active.
  const isActive = project?.status === "running" || project?.status === "paused";
  const pollRef = useRef(pollStatus);
  pollRef.current = pollStatus;
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => pollRef.current(), 3000);
    return () => clearInterval(interval);
  }, [isActive]);

  const startPipeline = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await authedFetch(`/api/projects/${params.id}/execute`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to start pipeline.");
      }
      // Optimistically flip to running so polling kicks in immediately.
      setProject((prev) => (prev ? { ...prev, status: "running" } : prev));
      pollStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start pipeline");
    } finally {
      setStarting(false);
    }
  };

  const approveCheckpoint = async (checkpointId: string, notes?: string) => {
    setApproving(true);
    setError(null);
    try {
      const res = await authedFetch(
        `/api/projects/${params.id}/checkpoint/${checkpointId}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(notes ? { userNotes: notes } : {}),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to approve checkpoint.");
      }
      setEditingCheckpoint(null);
      setEditNotes("");
      setProject((prev) => (prev ? { ...prev, status: "running" } : prev));
      pollStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to approve checkpoint");
    } finally {
      setApproving(false);
    }
  };

  const toggleExpand = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const orchestratorLabel = project
    ? modelLabelFor(project.orchestratorProvider, project.orchestratorModel)
    : "";

  const tasks = project?.tasks ?? [];
  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const progressPct = tasks.length
    ? Math.round((completedCount / tasks.length) * 100)
    : 0;
  const pendingCheckpoints = project?.checkpoints ?? [];
  const canStart =
    project &&
    (project.status === "draft" ||
      project.status === "completed" ||
      project.status === "failed");

  // Show the deliverable whenever one was composed — even on a partial-failure
  // run, the user should still get the best result the pipeline could produce.
  const finalReady = !!project?.finalOutput;
  // Collapse the step-by-step tasks once there's a final result, unless the
  // user has explicitly toggled them open.
  const stepsVisible = stepsOpen ?? !finalReady;

  const copyFinal = async () => {
    if (!project?.finalOutput) return;
    await navigator.clipboard.writeText(project.finalOutput);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <main className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/dashboard"
          className="mb-6 inline-block text-sm text-neutral-400 hover:text-white"
        >
          ← Back to dashboard
        </Link>

        {error && (
          <div className="mb-6 rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-neutral-500">Loading…</p>
        ) : project ? (
          <>
            <header className="mb-6 border-b border-neutral-800 pb-6">
              <div className="mb-3 flex items-start justify-between gap-3">
                <h1 className="text-2xl font-bold">{project.name}</h1>
                <span
                  className={`shrink-0 rounded px-2 py-0.5 text-xs capitalize ${STATUS_STYLES[project.status]}`}
                >
                  {project.status}
                </span>
              </div>
              <p className="mb-4 whitespace-pre-wrap text-neutral-300">
                {project.goal}
              </p>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-neutral-500">
                <span>Orchestrator: {orchestratorLabel}</span>
                <span>
                  Created {new Date(project.createdAt).toLocaleDateString()}
                </span>
              </div>
            </header>

            {/* Pipeline progress bar */}
            {tasks.length > 0 && (
              <div className="mb-6">
                <div className="mb-1 flex items-center justify-between text-xs text-neutral-400">
                  <span>
                    {completedCount} of {tasks.length} tasks complete
                  </span>
                  <span>{progressPct}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-green-500 transition-all duration-500"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Final deliverable — the one thing the user actually wants. */}
            {finalReady && (
              <section className="mb-8">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-green-300">
                    Final Result
                  </h2>
                  <button
                    type="button"
                    onClick={copyFinal}
                    className="rounded border border-neutral-700 px-3 py-1 text-sm text-neutral-300 hover:bg-neutral-900"
                  >
                    {copied ? "Copied ✓" : "Copy"}
                  </button>
                </div>
                <div className="rounded-lg border border-green-900 bg-green-950/20 p-5">
                  <pre className="whitespace-pre-wrap break-words font-sans text-[15px] leading-relaxed text-neutral-100">
                    {project.finalOutput}
                  </pre>
                </div>
              </section>
            )}

            <section className="mb-8">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold">
                    {finalReady ? "Steps" : "Tasks"}
                  </h2>
                  {finalReady && tasks.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setStepsOpen(!stepsVisible)}
                      className="text-sm text-neutral-400 hover:text-white"
                    >
                      {stepsVisible
                        ? "▾ Hide steps"
                        : `▸ Show steps (${tasks.length})`}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={startPipeline}
                  disabled={!canStart || starting}
                  className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {starting
                    ? "Starting…"
                    : project.status === "running" ||
                        project.status === "paused"
                      ? "Pipeline running…"
                      : tasks.length > 0
                        ? "Restart Pipeline"
                        : "Start Pipeline"}
                </button>
              </div>

              {tasks.length === 0 ? (
                <div className="rounded-lg border border-dashed border-neutral-800 p-8 text-center text-neutral-500">
                  No tasks yet. Click Start Pipeline and the orchestrator will
                  break your goal into tasks.
                </div>
              ) : !stepsVisible ? null : (
                <ul className="space-y-3">
                  {tasks.map((t) => {
                    const checkpoint = pendingCheckpoints.find(
                      (c) => c.taskId === t.id,
                    );
                    const isRunning = t.status === "running";
                    return (
                      <li
                        key={t.id}
                        className={`rounded-md border bg-neutral-900 p-4 transition ${
                          isRunning
                            ? "animate-pulse border-blue-600"
                            : "border-neutral-800"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">
                            {t.sequenceOrder}. {t.title}
                          </span>
                          <span
                            className={`flex items-center gap-1.5 shrink-0 rounded px-2 py-0.5 text-xs capitalize ${
                              TASK_STATUS_STYLES[t.status] ??
                              "bg-neutral-800 text-neutral-400"
                            }`}
                          >
                            {isRunning && (
                              <span className="inline-block h-2 w-2 animate-spin rounded-full border border-blue-300 border-t-transparent" />
                            )}
                            {t.status}
                          </span>
                        </div>

                        <p className="mt-1 text-sm text-neutral-400">
                          {t.instruction}
                        </p>

                        <div className="mt-2 flex flex-wrap gap-x-4 text-xs text-neutral-500">
                          <span>
                            Model:{" "}
                            {modelLabelFor(t.assignedProvider, t.assignedModel)}
                          </span>
                          {t.tokensUsed > 0 && (
                            <span>{t.tokensUsed} tokens</span>
                          )}
                        </div>

                        {/* Expandable output */}
                        {t.output && (
                          <div className="mt-3">
                            <button
                              type="button"
                              onClick={() => toggleExpand(t.id)}
                              className="text-xs text-neutral-400 hover:text-white"
                            >
                              {expanded[t.id] ? "▾ Hide output" : "▸ Show output"}
                            </button>
                            {expanded[t.id] && (
                              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-neutral-950 p-3 text-sm text-neutral-200">
                                {t.output}
                              </pre>
                            )}
                          </div>
                        )}

                        {/* Approval gate */}
                        {checkpoint && (
                          <div className="mt-4 rounded-md border border-amber-800 bg-amber-950/30 p-4">
                            <p className="mb-3 text-sm text-amber-200">
                              Pipeline paused — review the output above and
                              approve to continue.
                            </p>
                            {editingCheckpoint === checkpoint.id ? (
                              <div className="space-y-2">
                                <textarea
                                  value={editNotes}
                                  onChange={(e) => setEditNotes(e.target.value)}
                                  placeholder="Notes / guidance for the next steps…"
                                  rows={3}
                                  className="w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-sm text-neutral-100"
                                />
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    disabled={approving}
                                    onClick={() =>
                                      approveCheckpoint(checkpoint.id, editNotes)
                                    }
                                    className="rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-black hover:bg-amber-400 disabled:opacity-40"
                                  >
                                    {approving ? "Approving…" : "Submit & Approve"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingCheckpoint(null)}
                                    className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  disabled={approving}
                                  onClick={() => approveCheckpoint(checkpoint.id)}
                                  className="rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-black hover:bg-amber-400 disabled:opacity-40"
                                >
                                  {approving ? "Approving…" : "Approve"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingCheckpoint(checkpoint.id);
                                    setEditNotes("");
                                  }}
                                  className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
                                >
                                  Edit &amp; Approve
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
