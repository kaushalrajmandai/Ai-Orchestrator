// Load environment variables BEFORE importing @clerk/fastify. Its exported
// `clerkClient` singleton reads CLERK_SECRET_KEY from process.env at import
// time, so dotenv must run first or authenticated requests fail with
// "Missing Clerk Secret Key".
import "dotenv/config";

import Fastify from "fastify";
import cors from "@fastify/cors";
import { clerkPlugin } from "@clerk/fastify";
import { env } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { providerRoutes } from "./routes/providers.js";
import { projectRoutes } from "./routes/projects.js";
import { internalRoutes } from "./routes/internal.js";

async function buildServer() {
  const app = Fastify({
    logger: {
      level: env.nodeEnv === "production" ? "info" : "debug",
    },
  });

  // Tolerate an empty body on application/json requests (e.g. DELETE and POST
  // actions that carry no payload). The default parser rejects these with
  // FST_ERR_CTP_EMPTY_JSON_BODY, so treat empty as an empty object instead.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (body === "" || body == null) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  // CORS — allow the frontend origin(s) to call this API with credentials.
  await app.register(cors, {
    origin: env.corsOrigins,
    credentials: true,
  });

  // Clerk verifies session tokens on every request. Routes opt into
  // requiring auth via the requireAuth preHandler.
  await app.register(clerkPlugin, {
    publishableKey: env.clerkPublishableKey,
    secretKey: env.clerkSecretKey,
  });

  // Routes
  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(providerRoutes);
  await app.register(projectRoutes);
  await app.register(internalRoutes);

  return app;
}

async function start() {
  try {
    const app = await buildServer();
    await app.listen({ port: env.port, host: env.host });
    app.log.info(`API listening on http://${env.host}:${env.port}`);
  } catch (err) {
    console.error("Failed to start API server:", err);
    process.exit(1);
  }
}

start();
