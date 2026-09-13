import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase, getAuthenticatedUserId } from "@/lib/supabase-server";
import { resolvePlugin } from "@/lib/plugin-lookup";

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
    const userId = await getAuthenticatedUserId(supabase);
    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Verify ownership — resolve by slug or UUID
    const { plugin, error: lookupError } = await resolvePlugin(supabase, id);
    if (!plugin) {
      console.error("versions POST lookup failed", { id, lookupError, userId });
      return NextResponse.json({ error: lookupError }, { status: 404 });
    }
    if (plugin.author_id !== userId) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const pluginUuid = plugin.id;

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
        plugin_id: pluginUuid,
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
      .eq("id", pluginUuid);

    revalidatePath("/plugins");
    revalidatePath("/plugins/[id]", "page");
    revalidatePath("/plugins/publishers/[author]", "page");

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    console.error("POST /api/plugins/[id]/versions error:", err);
    return NextResponse.json(
      { error: "Failed to create version" },
      { status: 500 },
    );
  }
}
