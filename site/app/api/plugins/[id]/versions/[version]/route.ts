import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase, getAuthenticatedUserId } from "@/lib/supabase-server";
import { resolvePlugin } from "@/lib/plugin-lookup";

type RouteParams = { params: Promise<{ id: string; version: string }> };

/**
 * DELETE /api/plugins/:id/versions/:version — delete a specific version (owner only).
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id, version } = await params;
    const supabase = await createServerSupabase();

    // Check auth
    const userId = await getAuthenticatedUserId(supabase);
    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Verify ownership — resolve by slug or UUID
    const { plugin, error: lookupError } = await resolvePlugin(supabase, id);
    if (!plugin) {
      console.error("version DELETE lookup failed", { id, lookupError, userId });
      return NextResponse.json({ error: lookupError }, { status: 404 });
    }
    if (plugin.author_id !== userId) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const pluginUuid = plugin.id;

    // Delete the specific version
    const { error } = await supabase
      .from("plugin_versions")
      .delete()
      .eq("plugin_id", pluginUuid)
      .eq("version", version);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Touch updated_at on the plugin
    await supabase
      .from("plugins")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", pluginUuid);

    revalidatePath("/plugins");
    revalidatePath("/plugins/[id]", "page");
    revalidatePath("/plugins/publishers/[author]", "page");

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/plugins/[id]/versions/[version] error:", err);
    return NextResponse.json(
      { error: "Failed to delete version" },
      { status: 500 },
    );
  }
}
