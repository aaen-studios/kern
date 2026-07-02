import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/download?id={plugin_uuid}&v={version}
 * Serves the .kern file from Supabase Storage for the given plugin + version.
 * Returns a 302 redirect to a signed/download URL so the file streams directly
 * from the storage provider without going through our server.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const version = searchParams.get("v");

    if (!id || !version) {
      return NextResponse.json(
        { error: "id and v query params are required" },
        { status: 400 },
      );
    }

    const supabase = await createServerSupabase();

    // Look up the version record and plugin slug for the filename
    const { data: ver } = await supabase
      .from("plugin_versions")
      .select("storage_path, plugin_id")
      .eq("plugin_id", id)
      .eq("version", version)
      .single();

    if (!ver?.storage_path) {
      return NextResponse.json(
        { error: "Version not found or no file stored" },
        { status: 404 },
      );
    }

    // Get plugin slug for the download filename
    const { data: plugin } = await supabase
      .from("plugins")
      .select("slug")
      .eq("id", id)
      .single();

    const filename = plugin
      ? `${plugin.slug}-${version}.kern`
      : `plugin-${version}.kern`;

    // Generate a signed URL with the download filename
    const { data } = await supabase.storage
      .from("plugin-kern")
      .createSignedUrl(ver.storage_path, 3600, {
        download: filename,
      });

    if (!data?.signedUrl) {
      return NextResponse.json(
        { error: "File not found in storage" },
        { status: 404 },
      );
    }

    // Redirect to the signed URL
    return NextResponse.redirect(data.signedUrl);
  } catch (err) {
    console.error("GET /api/download error:", err);
    return NextResponse.json(
      { error: "Failed to serve download" },
      { status: 500 },
    );
  }
}
