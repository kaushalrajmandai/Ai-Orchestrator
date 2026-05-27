import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { Provider } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { getOrCreateUser } from "../lib/users.js";
import { encryptKey, decryptKey } from "../lib/encryption.js";
import { testProviderConnection } from "../lib/provider-service.js";
import { managedProviders } from "../lib/managed-keys.js";

const VALID_PROVIDERS = Object.values(Provider) as string[];

// Shape returned to clients. Never includes the encrypted key.
type ProviderKeyPublic = {
  id: string;
  provider: Provider;
  isManagedMode: boolean;
  createdAt: Date;
};

function toPublic(row: {
  id: string;
  provider: Provider;
  isManagedMode: boolean;
  createdAt: Date;
}): ProviderKeyPublic {
  return {
    id: row.id,
    provider: row.provider,
    isManagedMode: row.isManagedMode,
    createdAt: row.createdAt,
  };
}

// Select clause that deliberately omits encryptedKey so it can never leak.
const PUBLIC_SELECT = {
  id: true,
  provider: true,
  isManagedMode: true,
  createdAt: true,
} as const;

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  // Every route here requires a signed-in user.
  app.addHook("preHandler", requireAuth);

  // POST /api/providers — add (or update) a provider key.
  app.post("/api/providers", async (request, reply) => {
    const { userId: clerkId } = getAuth(request);
    const body = (request.body ?? {}) as {
      provider?: string;
      key?: string;
      isManagedMode?: boolean;
    };

    const provider = body.provider;
    const isManagedMode = Boolean(body.isManagedMode);
    const key = body.key;

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return reply.status(400).send({
        error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}.`,
      });
    }
    if (!isManagedMode && (!key || key.trim().length === 0)) {
      return reply.status(400).send({
        error: "An API key is required unless managed mode is enabled.",
      });
    }

    const user = await getOrCreateUser(clerkId!);

    // BYOK keys are encrypted at rest; managed mode stores no key.
    const encryptedKey = isManagedMode ? null : encryptKey(key!.trim());

    // One key per (user, provider): upsert so re-adding replaces the old key.
    const row = await prisma.providerKey.upsert({
      where: {
        userId_provider: { userId: user.id, provider: provider as Provider },
      },
      create: {
        userId: user.id,
        provider: provider as Provider,
        encryptedKey,
        isManagedMode,
      },
      update: { encryptedKey, isManagedMode },
      select: PUBLIC_SELECT,
    });

    return reply.status(201).send(toPublic(row));
  });

  // GET /api/providers/managed — which providers the platform supplies a key
  // for (managed tier). Booleans only; never returns the keys themselves.
  app.get("/api/providers/managed", async (_request, reply) => {
    return reply.send({ providers: managedProviders() });
  });

  // GET /api/providers — list the current user's provider keys (no secrets).
  app.get("/api/providers", async (request, reply) => {
    const { userId: clerkId } = getAuth(request);
    const user = await getOrCreateUser(clerkId!);

    const rows = await prisma.providerKey.findMany({
      where: { userId: user.id },
      select: PUBLIC_SELECT,
      orderBy: { createdAt: "asc" },
    });

    return reply.send(rows.map(toPublic));
  });

  // DELETE /api/providers/:id — remove a provider key the user owns.
  app.delete<{ Params: { id: string } }>(
    "/api/providers/:id",
    async (request, reply) => {
      const { userId: clerkId } = getAuth(request);
      const user = await getOrCreateUser(clerkId!);

      // Scope the delete to the owner so users can't delete others' keys.
      const result = await prisma.providerKey.deleteMany({
        where: { id: request.params.id, userId: user.id },
      });

      if (result.count === 0) {
        return reply.status(404).send({ error: "Provider key not found." });
      }
      return reply.status(204).send();
    },
  );

  // POST /api/providers/:id/test — verify the stored key still works.
  app.post<{ Params: { id: string } }>(
    "/api/providers/:id/test",
    async (request, reply) => {
      const { userId: clerkId } = getAuth(request);
      const user = await getOrCreateUser(clerkId!);

      const row = await prisma.providerKey.findFirst({
        where: { id: request.params.id, userId: user.id },
      });
      if (!row) {
        return reply.status(404).send({ error: "Provider key not found." });
      }

      // Managed mode uses platform keys; testing the user's own key is N/A.
      if (row.isManagedMode || !row.encryptedKey) {
        return reply.send({
          success: false,
          error: "Managed mode has no user key to test.",
        });
      }

      const plainKey = decryptKey(row.encryptedKey);
      const result = await testProviderConnection(row.provider, plainKey);
      return reply.send(result);
    },
  );
}
