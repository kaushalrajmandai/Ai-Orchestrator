import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { requireAuth } from "../middleware/auth.js";

// Example protected route. Verifies the Clerk session and returns the
// authenticated user's id. Real user provisioning (syncing Clerk users into
// the `users` table) is wired up in a later phase.
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", { preHandler: requireAuth }, async (request) => {
    const { userId } = getAuth(request);
    return { clerkId: userId };
  });
}
