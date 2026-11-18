import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

type PluginJoin = {
  id: string;
  slug: string;
};

type VersionWithPlugin = {
  storage_path: string;
  plugin: PluginJoin | null;
};

/**
 * Check if Supabase is configured (live mode).
 */
function isLive(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

/**
 * GET /api/download?id={plugin_id_or_slug}&v={version}
 * Serves the .kern file from Supabase Storage for the given plugin + version.
 * Returns a 302 redirect to a signed/download URL so the file streams directly
 * from the storage provider without going through our server.
 *
 * Note: This endpoint requires Supabase to be configured. Seed/fallback mode
 * does not serve downloads - users should deploy with proper storage configured.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const idOrSlug = searchParams.get("id");
  const version = searchParams.get("v");

  if (!idOrSlug || !version) {
    return NextResponse.json(
      { error: "id and v query params are required" },
      { status: 400 },
    );
  }

  // Live mode required for downloads
  if (!isLive()) {
    return NextResponse.json(
      { error: "Storage not configured. Supabase must be configured for plugin downloads." },
      { status: 503 },
    );
  }

  try {
    const supabase = await createServerSupabase();

    // Look up the version record — try by plugin UUID first, then by slug
    let { data: ver } = await supabase
      .from("plugin_versions")
      .select("storage_path, plugin:plugins!inner(id, slug)")
      .eq("plugin_id", idOrSlug)
      .eq("version", version)
      .single() as unknown as { data: VersionWithPlugin | null };

    // If not found by UUID, try by slug
    if (!ver?.storage_path) {
      const { data: bySlug } = await supabase
        .from("plugin_versions")
        .select("storage_path, plugin:plugins!inner(id, slug)")
        .eq("plugins.slug", idOrSlug)
        .eq("version", version)
        .single() as unknown as { data: VersionWithPlugin | null };
      ver = bySlug;
    }

    if (!ver?.storage_path) {
      return NextResponse.json(
        { error: "Version not found or no file stored" },
        { status: 404 },
      );
    }

    // Get plugin slug for the download filename
    const pluginSlug = ver.plugin?.slug ?? idOrSlug;
    const filename = `${pluginSlug}-${version}.kern`;

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
