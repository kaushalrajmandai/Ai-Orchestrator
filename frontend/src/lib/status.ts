// Project status values mirror the Prisma `ProjectStatus` enum.
export type ProjectStatus =
  | "draft"
  | "running"
  | "paused"
  | "completed"
  | "failed";

// Tailwind classes for each status badge.
export const STATUS_STYLES: Record<ProjectStatus, string> = {
  draft: "bg-neutral-800 text-neutral-300",
  running: "bg-blue-950 text-blue-300",
  paused: "bg-amber-950 text-amber-300",
  completed: "bg-green-950 text-green-300",
  failed: "bg-red-950 text-red-300",
};
