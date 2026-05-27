import type { FastifyInstance } from "fastify";

// Public liveness probe. Used by load balancers and local sanity checks.
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    return { status: "ok", service: "api", timestamp: new Date().toISOString() };
  });
}
