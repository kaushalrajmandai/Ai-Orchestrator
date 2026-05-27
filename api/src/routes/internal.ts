import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Provider, ProjectStatus, TaskStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decryptKey } from "../lib/encryption.js";
import { getManagedKey } from "../lib/managed-keys.js";
import { env } from "../config/env.js";

// Routes called by the Python orchestration engine — NOT by browsers. They are
// authenticated with a shared secret header instead of Clerk sessions, since
// the orchestrator runs server-side with no user token.

const VALID_PROVIDERS = Object.values(Provider) as string[];
const VALID_TASK_STATUS = Object.values(TaskStatus) as string[];
const VALID_PROJECT_STATUS = Object.values(ProjectStatus) as string[];

// Rejects any request without a matching x-internal-secret header.
async function requireInternalSecret(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const provided = request.headers["x-internal-secret"];
  if (provided !== env.internalSecret) {
    await reply.status(401).send({ error: "Invalid internal secret." });
  }
}

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireInternalSecret);

  // POST /api/internal/tasks/create — bulk-create the orchestrator's task plan.
  // Tasks are numbered sequentially from 1 in the order received.
  app.post("/api/internal/tasks/create", async (request, reply) => {
    const body = (request.body ?? {}) as {
      projectId?: string;
      tasks?: Array<{
        title?: string;
        instruction?: string;
        provider?: string;
        model?: string;
      }>;
    };

    const { projectId, tasks } = body;
    if (!projectId || !Array.isArray(tasks) || tasks.length === 0) {
      return reply
        .status(400)
        .send({ error: "projectId and a non-empty tasks array are required." });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) {
      return reply.status(404).send({ error: "Project not found." });
    }

    // Replace any existing tasks so re-runs start clean (checkpoints/files
    // cascade off tasks via the schema).
    await prisma.task.deleteMany({ where: { projectId } });

    const created = await prisma.$transaction(
      tasks.map((t, i) => {
        const provider =
          t.provider && VALID_PROVIDERS.includes(t.provider)
            ? (t.provider as Provider)
            : null;
        return prisma.task.create({
          data: {
            projectId,
            sequenceOrder: i + 1,
            title: t.title?.trim() || `Task ${i + 1}`,
            instruction: t.instruction?.trim() || "",
            assignedProvider: provider,
            assignedModel: t.model?.trim() || null,
          },
          select: { id: true, sequenceOrder: true },
        });
      }),
    );

    return reply.status(201).send({ tasks: created });
  });

  // POST /api/internal/tasks/:id/update — update status/output of one task.
  app.post<{ Params: { id: string } }>(
    "/api/internal/tasks/:id/update",
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        status?: string;
        output?: string;
        tokensUsed?: number;
        assignedProvider?: string;
        assignedModel?: string;
      };

      const data: {
        status?: TaskStatus;
        output?: string;
        tokensUsed?: number;
        completedAt?: Date;
        assignedProvider?: Provider;
        assignedModel?: string;
      } = {};

      if (body.status !== undefined) {
        if (!VALID_TASK_STATUS.includes(body.status)) {
          return reply.status(400).send({ error: "Invalid task status." });
        }
        data.status = body.status as TaskStatus;
        if (body.status === "completed" || body.status === "failed") {
          data.completedAt = new Date();
        }
      }
      if (body.output !== undefined) data.output = body.output;
      if (typeof body.tokensUsed === "number") data.tokensUsed = body.tokensUsed;
      if (
        body.assignedProvider &&
        VALID_PROVIDERS.includes(body.assignedProvider)
      ) {
        data.assignedProvider = body.assignedProvider as Provider;
      }
      if (body.assignedModel) data.assignedModel = body.assignedModel;

      try {
        await prisma.task.update({
          where: { id: request.params.id },
          data,
        });
      } catch {
        return reply.status(404).send({ error: "Task not found." });
      }
      return reply.send({ success: true });
    },
  );

  // POST /api/internal/checkpoints/create — open an approval gate for a task.
  app.post("/api/internal/checkpoints/create", async (request, reply) => {
    const body = (request.body ?? {}) as {
      projectId?: string;
      taskId?: string;
    };
    if (!body.projectId || !body.taskId) {
      return reply
        .status(400)
        .send({ error: "projectId and taskId are required." });
    }

    const checkpoint = await prisma.checkpoint.create({
      data: { projectId: body.projectId, taskId: body.taskId },
      select: { id: true, status: true },
    });
    return reply.status(201).send(checkpoint);
  });

  // GET /api/internal/checkpoints/:id — the orchestrator polls this to learn
  // when a paused pipeline has been approved.
  app.get<{ Params: { id: string } }>(
    "/api/internal/checkpoints/:id",
    async (request, reply) => {
      const checkpoint = await prisma.checkpoint.findUnique({
        where: { id: request.params.id },
        select: { id: true, status: true, userNotes: true },
      });
      if (!checkpoint) {
        return reply.status(404).send({ error: "Checkpoint not found." });
      }
      return reply.send(checkpoint);
    },
  );

  // POST /api/internal/projects/:id/status — update overall pipeline status,
  // and optionally store the composed final deliverable.
  app.post<{ Params: { id: string } }>(
    "/api/internal/projects/:id/status",
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        status?: string;
        finalOutput?: string;
      };
      if (!body.status || !VALID_PROJECT_STATUS.includes(body.status)) {
        return reply.status(400).send({ error: "Invalid project status." });
      }
      const data: { status: ProjectStatus; finalOutput?: string } = {
        status: body.status as ProjectStatus,
      };
      if (body.finalOutput !== undefined) data.finalOutput = body.finalOutput;
      try {
        await prisma.project.update({
          where: { id: request.params.id },
          data,
        });
      } catch {
        return reply.status(404).send({ error: "Project not found." });
      }
      return reply.send({ success: true });
    },
  );

  // GET /api/internal/projects/:id/keys — decrypted BYOK keys for the project's
  // owner, keyed by provider. Managed-mode entries are omitted (no user key).
  app.get<{ Params: { id: string } }>(
    "/api/internal/projects/:id/keys",
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { userId: true },
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found." });
      }

      const rows = await prisma.providerKey.findMany({
        where: { userId: project.userId },
      });
      const byokByProvider = new Map(rows.map((r) => [r.provider, r]));

      // For each provider, prefer the user's BYOK key; otherwise fall back to
      // the platform's managed key. This is what lets the orchestrator route
      // across every funded provider (managed + BYOK) for true multi-model.
      const keys: Record<string, string> = {};
      for (const provider of Object.values(Provider)) {
        const row = byokByProvider.get(provider);
        if (row && !row.isManagedMode && row.encryptedKey) {
          try {
            keys[provider] = decryptKey(row.encryptedKey);
            continue;
          } catch {
            // Fall through to managed if the BYOK key can't be decrypted.
          }
        }
        const managed = getManagedKey(provider);
        if (managed) keys[provider] = managed;
      }
      return reply.send({ keys });
    },
  );
}
