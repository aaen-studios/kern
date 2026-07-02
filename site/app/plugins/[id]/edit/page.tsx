import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPlugin } from "@/lib/registry";
import { EditPluginForm } from "@/components/plugins/EditPluginForm";
import { SignInGate } from "@/components/auth/SignInGate";
import { createServerSupabase } from "@/lib/supabase-server";

type Props = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const plugin = await getPlugin(id);
  if (!plugin) return { title: "not found" };
  return {
    title: `edit ${plugin.display_name}`,
  };
}

export default async function EditPluginPage({ params }: Props) {
  const { id } = await params;
  const plugin = await getPlugin(id);
  if (!plugin) notFound();

  // Check auth and ownership
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Determine what to show
  let body: React.ReactNode;

  if (!user) {
    body = (
      <SignInGate message="sign in with github to edit your plugins." />
    );
  } else {
    const { data: profile } = await supabase
      .from("profiles")
      .select("github_user")
      .eq("id", user.id)
      .single();

    const author = plugin.author_github ?? plugin.author;
    if (!profile || profile.github_user !== author) {
      body = (
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <p className="font-mono text-sm text-signal-low">
            this isn&apos;t your plugin — you can&apos;t edit it.
          </p>
        </div>
      );
    } else {
      body = <EditPluginForm plugin={plugin} />;
    }
  }

  return (
    <main className="mx-auto max-w-[1080px] px-4 pb-24 pt-28 sm:px-6">
      <header className="mb-10">
        <p className="font-mono text-xs lowercase text-signal-low">
          {"// "}edit
        </p>
        <h1 className="mt-2 font-mono text-3xl lowercase text-zinc-100">
          edit {plugin.display_name}
        </h1>
      </header>

      {body}
    </main>
  );
}
