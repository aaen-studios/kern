import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

type RouteParams = { params: Promise<{ id: string; version: string }> };

/**
 * DELETE /api/plugins/:id/versions/:version — delete a specific version (owner only).
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id, version } = await params;
    const supabase = await createServerSupabase();

    // Check auth
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Verify ownership — resolve by slug or UUID
    let { data: plugin } = await supabase
      .from("plugins")
      .select("id, author_id")
      .eq("slug", id)
      .single();

    if (!plugin) {
      const { data: fallback } = await supabase
        .from("plugins")
        .select("id, author_id")
        .eq("id", id)
        .single();
      plugin = fallback ?? null;
    }

    if (!plugin) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }
    if (plugin.author_id !== user.id) {
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

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/plugins/[id]/versions/[version] error:", err);
    return NextResponse.json(
      { error: "Failed to delete version" },
      { status: 500 },
    );
  }
}
