import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SubmitPluginForm } from "@/components/plugins/SubmitPluginForm";
import { SignInGate } from "@/components/auth/SignInGate";
import { createServerSupabase } from "@/lib/supabase-server";

export const metadata: Metadata = {
  title: "submit a plugin",
  description:
    "publish a .kern plugin to the kern registry. sign in with GitHub to get started.",
};

export default async function SubmitPluginPage() {
  // Check if Supabase is configured
  const isConfigured =
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!isConfigured) {
    redirect("https://github.com/aaen-studios/kern-registry");
  }

  // Check auth
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto max-w-[1080px] px-4 pb-24 pt-28 sm:px-6">
      <header className="mb-10">
        <p className="font-mono text-xs lowercase text-signal-low">
          {"// "}publish
        </p>
        <h1 className="mt-2 font-mono text-3xl lowercase text-zinc-100">
          submit a plugin
        </h1>
        <p className="mt-3 max-w-xl font-mono text-xs text-signal-low">
          upload your <code className="text-signal-high">.kern</code> file,
          fill in the details, and publish to the registry.
        </p>
      </header>

      {user ? (
        <SubmitPluginForm />
      ) : (
        <SignInGate message="sign in with github to publish plugins to the registry." />
      )}
    </main>
  );
}
