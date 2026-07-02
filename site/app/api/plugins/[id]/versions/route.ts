import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/plugins/:id/versions — upload a new version (owner only).
 * Body: { version, kern_compat, storage_path, sha256, size_bytes, changelog }
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createServerSupabase();

    // Check auth
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Verify ownership
    const { data: plugin } = await supabase
      .from("plugins")
      .select("author_id, slug")
      .eq("id", id)
      .single();

    if (!plugin) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }
    if (plugin.author_id !== user.id) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const body = await request.json();
    const { version, kern_compat, storage_path, sha256, size_bytes, changelog } = body;

    if (!version || !storage_path || !sha256 || !size_bytes) {
      return NextResponse.json(
        { error: "version, storage_path, sha256, and size_bytes are required" },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from("plugin_versions")
      .insert({
        plugin_id: id,
        version,
        kern_compat,
        storage_path,
        sha256,
        size_bytes,
        changelog,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Update plugin's updated_at timestamp
    await supabase
      .from("plugins")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", id);

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    console.error("POST /api/plugins/[id]/versions error:", err);
    return NextResponse.json(
      { error: "Failed to create version" },
      { status: 500 },
    );
  }
}
