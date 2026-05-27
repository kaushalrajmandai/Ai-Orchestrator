import type { Provider } from "@prisma/client";
import { env } from "../config/env.js";

// Single source of truth for managed-tier platform keys. Returns the platform's
// own key for a provider when configured (managed tier), or null. Both the
// execute route and the internal keys endpoint resolve through here so they
// agree on what's available.

export function getManagedKey(provider: Provider): string | null {
  const key = env.managedKeys[provider];
  return key && key.trim().length > 0 ? key.trim() : null;
}

// List of providers that currently have a managed key configured (no secrets).
export function managedProviders(): Provider[] {
  return (Object.keys(env.managedKeys) as Provider[]).filter(
    (p) => getManagedKey(p) !== null,
  );
}
