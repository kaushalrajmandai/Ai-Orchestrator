import { clerkClient } from "@clerk/fastify";
import { prisma } from "./prisma.js";
import type { User } from "@prisma/client";

// Maps a verified Clerk user id to our internal User row, creating it on first
// access. This lazy provisioning means we don't need Clerk webhooks yet —
// the first authenticated API call materializes the user.
export async function getOrCreateUser(clerkId: string): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { clerkId } });
  if (existing) {
    return existing;
  }

  // Fetch the primary email from Clerk to populate the new row.
  const clerkUser = await clerkClient.users.getUser(clerkId);
  const email =
    clerkUser.emailAddresses.find(
      (e) => e.id === clerkUser.primaryEmailAddressId,
    )?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    `${clerkId}@unknown.local`;

  return prisma.user.create({
    data: { clerkId, email },
  });
}
