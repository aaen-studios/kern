import type { createServerSupabase } from "@/lib/supabase-server";

type ServerSupabase = Awaited<ReturnType<typeof createServerSupabase>>;

export interface PluginRef {
  id: string;
  author_id: string;
}

/**
 * Resolves a plugin by slug first, then by UUID.
 *
 * Both lookups previously dropped their PostgREST error, so any failure
 * (auth, validation, network) surfaced as a misleading 404 "Plugin not
 * found". Return the underlying message instead so callers can report it.
 */
export async function resolvePlugin(
  supabase: ServerSupabase,
  id: string,
): Promise<{ plugin: PluginRef | null; error: string | null }> {
  const bySlug = await supabase
    .from("plugins")
    .select("id, author_id")
    .eq("slug", id)
    .single();
  if (bySlug.data) return { plugin: bySlug.data, error: null };

  const byId = await supabase
    .from("plugins")
    .select("id, author_id")
    .eq("id", id)
    .single();
  if (byId.data) return { plugin: byId.data, error: null };

  const detail =
    bySlug.error?.message ?? byId.error?.message ?? "no matching row";
  return { plugin: null, error: `Plugin not found for "${id}" (${detail})` };
}
