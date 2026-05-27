import Link from "next/link";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-8 text-center">
      <div className="max-w-2xl space-y-4">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          AI Orchestrator
        </h1>
        <p className="text-lg text-neutral-400">
          Hire a team of AI specialists. Give them a goal. Watch them
          collaborate to get it done — no code required.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <SignedOut>
          <Link
            href="/sign-in"
            className="rounded-md bg-white px-5 py-2.5 font-medium text-black transition hover:bg-neutral-200"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="rounded-md border border-neutral-700 px-5 py-2.5 font-medium transition hover:bg-neutral-900"
          >
            Sign up
          </Link>
        </SignedOut>

        <SignedIn>
          <Link
            href="/dashboard"
            className="rounded-md bg-white px-5 py-2.5 font-medium text-black transition hover:bg-neutral-200"
          >
            Go to dashboard
          </Link>
          <UserButton />
        </SignedIn>
      </div>
    </main>
  );
}
