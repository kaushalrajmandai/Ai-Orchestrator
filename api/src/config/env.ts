import "dotenv/config";

// Centralized, validated environment access. Fail fast at boot if a required
// secret is missing rather than discovering it mid-request.
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  port: Number(optional("PORT", "4000")),
  host: optional("HOST", "0.0.0.0"),

  // Clerk backend keys — used by @clerk/fastify to verify sessions.
  clerkPublishableKey: required("CLERK_PUBLISHABLE_KEY"),
  clerkSecretKey: required("CLERK_SECRET_KEY"),

  databaseUrl: required("DATABASE_URL"),

  // Comma-separated list of allowed CORS origins (e.g. the frontend URL).
  corsOrigins: optional("CORS_ORIGINS", "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  // AES-256 key (32 bytes, hex-encoded) used to encrypt provider API keys.
  encryptionKey: optional("ENCRYPTION_KEY", ""),

  // Shared secret authenticating internal calls from the Python orchestrator.
  internalSecret: required("INTERNAL_SECRET"),

  // Base URL of the Python orchestration engine.
  orchestratorUrl: optional("ORCHESTRATOR_URL", "http://localhost:8000"),

  // Managed-tier platform keys. When set, the platform supplies these keys so
  // users can run pipelines without bringing their own (BYOK still takes
  // precedence). Empty string = not configured for that provider.
  managedKeys: {
    openai: optional("MANAGED_OPENAI_KEY", ""),
    anthropic: optional("MANAGED_ANTHROPIC_KEY", ""),
    gemini: optional("MANAGED_GEMINI_KEY", ""),
    deepseek: optional("MANAGED_DEEPSEEK_KEY", ""),
  } as Record<string, string>,
};
