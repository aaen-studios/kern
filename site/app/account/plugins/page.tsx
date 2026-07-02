import type { Metadata } from "next";
import { MyPluginTable } from "@/components/plugins/MyPluginTable";
import { SignInGate } from "@/components/auth/SignInGate";
import { createServerSupabase } from "@/lib/supabase-server";

export const metadata: Metadata = {
  title: "my plugins",
  description: "manage your published kern plugins.",
};

export default async function MyPluginsPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto max-w-[1080px] px-4 pb-24 pt-28 sm:px-6">
      <header className="mb-10">
        <p className="font-mono text-xs lowercase text-signal-low">
          {"// "}dashboard
        </p>
        <h1 className="mt-2 font-mono text-3xl lowercase text-zinc-100">
          my plugins
        </h1>
        <p className="mt-3 font-mono text-xs text-signal-low">
          manage your published plugins and submit new ones.
        </p>
      </header>

      {user ? (
        <MyPluginTable />
      ) : (
        <SignInGate message="sign in with github to manage your plugins." />
      )}
    </main>
  );
}
