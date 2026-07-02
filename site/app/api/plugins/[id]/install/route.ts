import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/plugins/:id/install — increment the install counter.
 * Called when someone clicks "install in kern."
 */
export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createServerSupabase();

    // Resolve plugin by slug or UUID
    let { data: plugin } = await supabase
      .from("plugins")
      .select("id, install_count")
      .eq("slug", id)
      .single();

    if (!plugin) {
      const { data: fallback } = await supabase
        .from("plugins")
        .select("id, install_count")
        .eq("id", id)
        .single();
      plugin = fallback ?? null;
    }

    if (!plugin) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }

    const pluginUuid = plugin.id;

    await supabase
      .from("plugins")
      .update({ install_count: (plugin.install_count ?? 0) + 1 })
      .eq("id", pluginUuid);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("POST /api/plugins/[id]/install error:", err);
    // Don't throw — install tracking is fire-and-forget
    return NextResponse.json({ success: false });
  }
}
