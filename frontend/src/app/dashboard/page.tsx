"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { UserButton } from "@clerk/nextjs";
import { findModel } from "@/lib/models";
import { STATUS_STYLES, type ProjectStatus } from "@/lib/status";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type Project = {
  id: string;
  name: string;
  goal: string;
  status: ProjectStatus;
  orchestratorProvider: string;
  orchestratorModel: string;
  createdAt: string;
};

export default function DashboardPage() {
  const { getToken } = useAuth();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/projects`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to load projects (${res.status})`);
      setProjects(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <main className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <header className="mx-auto mb-8 flex max-w-5xl items-center justify-between border-b border-neutral-800 pb-4">
        <h1 className="text-2xl font-bold">Projects</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/settings/providers"
            className="text-sm text-neutral-300 hover:text-white"
          >
            Providers
          </Link>
          <Link
            href="/dashboard/new"
            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black hover:bg-neutral-200"
          >
            New Project
          </Link>
          <UserButton />
        </div>
      </header>

      <div className="mx-auto max-w-5xl">
        {error && (
          <div className="mb-6 rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-neutral-500">Loading…</p>
        ) : projects.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-800 p-12 text-center">
            <p className="mb-1 text-lg font-medium">No projects yet</p>
            <p className="mb-6 text-neutral-500">
              Create your first project and let AI models collaborate toward
              your goal.
            </p>
            <Link
              href="/dashboard/new"
              className="inline-block rounded-md bg-white px-5 py-2 font-medium text-black hover:bg-neutral-200"
            >
              Create your first project
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const model = findModel(project.orchestratorModel);
  const modelLabel = model
    ? `${model.providerLabel} · ${model.name}`
    : `${project.orchestratorProvider} · ${project.orchestratorModel}`;

  return (
    <Link
      href={`/dashboard/${project.id}`}
      className="flex flex-col rounded-lg border border-neutral-800 bg-neutral-900 p-5 transition-colors hover:border-neutral-700"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <h2 className="font-semibold">{project.name}</h2>
        <span
          className={`shrink-0 rounded px-2 py-0.5 text-xs capitalize ${STATUS_STYLES[project.status]}`}
        >
          {project.status}
        </span>
      </div>
      <p className="mb-4 line-clamp-2 text-sm text-neutral-400">
        {project.goal}
      </p>
      <div className="mt-auto flex items-center justify-between text-xs text-neutral-500">
        <span>{modelLabel}</span>
        <span>{new Date(project.createdAt).toLocaleDateString()}</span>
      </div>
    </Link>
  );
}
