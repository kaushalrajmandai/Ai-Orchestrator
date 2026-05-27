import type { FastifyRequest, FastifyReply } from "fastify";
import { getAuth } from "@clerk/fastify";

// preHandler hook that rejects unauthenticated requests with 401.
// Attach to any route (or route group) that requires a signed-in user.
//
// On success, the verified Clerk user id is available downstream via
// getAuth(request).userId.
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { userId } = getAuth(request);

  if (!userId) {
    await reply.status(401).send({ error: "Unauthorized" });
  }
}
