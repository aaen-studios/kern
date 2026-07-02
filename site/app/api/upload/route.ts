import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/upload — generate a presigned upload URL for a .kern file.
 * Body: { plugin_id: string, version: string, file_name: string }
 * Returns a URL that the client can PUT the file to directly.
 *
 * Alternatively, the client can upload directly in the form using:
 *   supabase.storage.from('plugin-kern').upload(path, file)
 *
 * This endpoint is for the presigned-URL approach, which avoids
 * loading the file through our server.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();

    // Check auth
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();
    const { plugin_id, version, file_name } = body;

    if (!plugin_id || !version || !file_name) {
      return NextResponse.json(
        { error: "plugin_id, version, and file_name are required" },
        { status: 400 },
      );
    }

    // Verify plugin ownership
    const { data: plugin } = await supabase
      .from("plugins")
      .select("author_id, slug")
      .eq("id", plugin_id)
      .single();

    if (!plugin) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }
    if (plugin.author_id !== user.id) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    // Generate a presigned upload URL
    const filePath = `${plugin_id}/${version}/plugin.kern`;
    const { data, error } = await supabase.storage
      .from("plugin-kern")
      .createSignedUploadUrl(filePath);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      url: data.signedUrl,
      path: filePath,
      token: data.token,
    });
  } catch (err) {
    console.error("POST /api/upload error:", err);
    return NextResponse.json(
      { error: "Failed to create upload URL" },
      { status: 500 },
    );
  }
}
