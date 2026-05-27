import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { Provider } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { getOrCreateUser } from "../lib/users.js";
import { decryptKey } from "../lib/encryption.js";
import { getManagedKey } from "../lib/managed-keys.js";
import { env } from "../config/env.js";

const VALID_PROVIDERS = Object.values(Provider) as string[];

// Fields returned in list/summary views — omits the heavy tasks relation.
const PROJECT_SELECT = {
  id: true,
  name: true,
  goal: true,
  status: true,
  orchestratorProvider: true,
  orchestratorModel: true,
  finalOutput: true,
  createdAt: true,
} as const;

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  // Every route here requires a signed-in user.
  app.addHook("preHandler", requireAuth);

  // POST /api/projects — create a new project in draft status.
  app.post("/api/projects", async (request, reply) => {
    const { userId: clerkId } = getAuth(request);
    const body = (request.body ?? {}) as {
      name?: string;
      goal?: string;
      orchestratorProvider?: string;
      orchestratorModel?: string;
    };

    const name = body.name?.trim();
    const goal = body.goal?.trim();
    const orchestratorProvider = body.orchestratorProvider;
    const orchestratorModel = body.orchestratorModel?.trim();

    if (!name) {
      return reply.status(400).send({ error: "A project name is required." });
    }
    if (!goal) {
      return reply.status(400).send({ error: "A project goal is required." });
    }
    if (
      !orchestratorProvider ||
      !VALID_PROVIDERS.includes(orchestratorProvider)
    ) {
      return reply.status(400).send({
        error: `Invalid orchestrator provider. Must be one of: ${VALID_PROVIDERS.join(", ")}.`,
      });
    }
    if (!orchestratorModel) {
      return reply
        .status(400)
        .send({ error: "An orchestrator model is required." });
    }

    const user = await getOrCreateUser(clerkId!);

    const project = await prisma.project.create({
      data: {
        userId: user.id,
        name,
        goal,
        orchestratorProvider: orchestratorProvider as Provider,
        orchestratorModel,
      },
      select: PROJECT_SELECT,
    });

    return reply.status(201).send(project);
  });

  // GET /api/projects — list the current user's projects (newest first).
  app.get("/api/projects", async (request, reply) => {
    const { userId: clerkId } = getAuth(request);
    const user = await getOrCreateUser(clerkId!);

    const projects = await prisma.project.findMany({
      where: { userId: user.id },
      select: PROJECT_SELECT,
      orderBy: { createdAt: "desc" },
    });

    return reply.send(projects);
  });

  // GET /api/projects/:id — single project with its tasks (ordered).
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const { userId: clerkId } = getAuth(request);
      const user = await getOrCreateUser(clerkId!);

      const project = await prisma.project.findFirst({
        where: { id: request.params.id, userId: user.id },
        select: {
          ...PROJECT_SELECT,
          tasks: {
            orderBy: { sequenceOrder: "asc" },
            select: {
              id: true,
              sequenceOrder: true,
              title: true,
              instruction: true,
              assignedProvider: true,
              assignedModel: true,
              status: true,
              output: true,
              tokensUsed: true,
              createdAt: true,
              completedAt: true,
            },
          },
        },
      });

      if (!project) {
        return reply.status(404).send({ error: "Project not found." });
      }
      return reply.send(project);
    },
  );

  // PATCH /api/projects/:id — update editable fields (name, goal).
  app.patch<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const { userId: clerkId } = getAuth(request);
      const user = await getOrCreateUser(clerkId!);

      const body = (request.body ?? {}) as { name?: string; goal?: string };
      const data: { name?: string; goal?: string } = {};

      if (body.name !== undefined) {
        const name = body.name.trim();
        if (!name) {
          return reply
            .status(400)
            .send({ error: "Project name cannot be empty." });
        }
        data.name = name;
      }
      if (body.goal !== undefined) {
        const goal = body.goal.trim();
        if (!goal) {
          return reply
            .status(400)
            .send({ error: "Project goal cannot be empty." });
        }
        data.goal = goal;
      }

      if (Object.keys(data).length === 0) {
        return reply
          .status(400)
          .send({ error: "Nothing to update. Provide name and/or goal." });
      }

      // Scope to the owner so users can't update others' projects.
      const result = await prisma.project.updateMany({
        where: { id: request.params.id, userId: user.id },
        data,
      });
      if (result.count === 0) {
        return reply.status(404).send({ error: "Project not found." });
      }

      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: PROJECT_SELECT,
      });
      return reply.send(project);
    },
  );

  // DELETE /api/projects/:id — delete a project (tasks cascade via schema).
  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const { userId: clerkId } = getAuth(request);
      const user = await getOrCreateUser(clerkId!);

      const result = await prisma.project.deleteMany({
        where: { id: request.params.id, userId: user.id },
      });
      if (result.count === 0) {
        return reply.status(404).send({ error: "Project not found." });
      }
      return reply.status(204).send();
    },
  );

  // POST /api/projects/:id/execute — kick off the orchestration pipeline.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/execute",
    async (request, reply) => {
      const { userId: clerkId } = getAuth(request);
      const user = await getOrCreateUser(clerkId!);

      const project = await prisma.project.findFirst({
        where: { id: request.params.id, userId: user.id },
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found." });
      }

      // Resolve the orchestrator key: the user's own (BYOK) key takes
      // precedence; otherwise fall back to the platform's managed key.
      const orchestratorKeyRow = await prisma.providerKey.findUnique({
        where: {
          userId_provider: {
            userId: user.id,
            provider: project.orchestratorProvider,
          },
        },
      });

      let orchestratorKey: string | null = null;
      if (orchestratorKeyRow && !orchestratorKeyRow.isManagedMode && orchestratorKeyRow.encryptedKey) {
        try {
          orchestratorKey = decryptKey(orchestratorKeyRow.encryptedKey);
        } catch {
          return reply.status(500).send({
            error: "Stored provider key could not be decrypted.",
          });
        }
      } else {
        // No usable BYOK key — use the managed platform key if available.
        orchestratorKey = getManagedKey(project.orchestratorProvider);
      }

      if (!orchestratorKey) {
        return reply.status(400).send({
          error: `No key available for ${project.orchestratorProvider}. Add your own key on the Providers page, or ask the operator to configure a managed key for this provider.`,
        });
      }

      // Mark running up front so the UI reflects the state immediately.
      await prisma.project.update({
        where: { id: project.id },
        data: { status: "running" },
      });

      try {
        const res = await fetch(`${env.orchestratorUrl}/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": env.internalSecret,
          },
          body: JSON.stringify({
            project_id: project.id,
            goal: project.goal,
            orchestrator_provider: project.orchestratorProvider,
            orchestrator_model: project.orchestratorModel,
            orchestrator_key: orchestratorKey,
            user_id: user.id,
            api_callback_url: `http://localhost:${env.port}`,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          throw new Error(`orchestrator responded ${res.status}`);
        }
      } catch (err) {
        // Roll the project back to failed so the user can retry.
        await prisma.project.update({
          where: { id: project.id },
          data: { status: "failed" },
        });
        request.log.error({ err }, "Failed to reach orchestration engine");
        return reply.status(502).send({
          error:
            "Could not reach the orchestration engine. Is the Python service running on port 8000?",
        });
      }

      return reply.send({ success: true, message: "Pipeline started" });
    },
  );

  // POST /api/projects/:id/checkpoint/:checkpointId/approve — release a gate.
  app.post<{ Params: { id: string; checkpointId: string } }>(
    "/api/projects/:id/checkpoint/:checkpointId/approve",
    async (request, reply) => {
      const { userId: clerkId } = getAuth(request);
      const user = await getOrCreateUser(clerkId!);
      const body = (request.body ?? {}) as { userNotes?: string };

      // Verify the checkpoint belongs to a project the user owns.
      const checkpoint = await prisma.checkpoint.findFirst({
        where: {
          id: request.params.checkpointId,
          projectId: request.params.id,
          project: { userId: user.id },
        },
      });
      if (!checkpoint) {
        return reply.status(404).send({ error: "Checkpoint not found." });
      }

      await prisma.checkpoint.update({
        where: { id: checkpoint.id },
        data: {
          status: "approved",
          userNotes: body.userNotes?.trim() || null,
        },
      });

      // Resume the pipeline view; the orchestrator polls and continues.
      await prisma.project.update({
        where: { id: request.params.id },
        data: { status: "running" },
      });

      return reply.send({ success: true, message: "Checkpoint approved" });
    },
  );

  // GET /api/projects/:id/status — live status for polling: project + tasks +
  // any pending checkpoints (so the UI can render the approval gate).
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/status",
    async (request, reply) => {
      const { userId: clerkId } = getAuth(request);
      const user = await getOrCreateUser(clerkId!);

      const project = await prisma.project.findFirst({
        where: { id: request.params.id, userId: user.id },
        select: {
          id: true,
          name: true,
          status: true,
          finalOutput: true,
          tasks: {
            orderBy: { sequenceOrder: "asc" },
            select: {
              id: true,
              sequenceOrder: true,
              title: true,
              instruction: true,
              assignedProvider: true,
              assignedModel: true,
              status: true,
              output: true,
              tokensUsed: true,
              completedAt: true,
            },
          },
          checkpoints: {
            where: { status: "pending" },
            select: { id: true, taskId: true, status: true },
          },
        },
      });

      if (!project) {
        return reply.status(404).send({ error: "Project not found." });
      }
      return reply.send(project);
    },
  );
}
