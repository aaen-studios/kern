import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/plugins/:id/upvote — toggle an upvote (anonymous).
 * Body: { voter_id: string } — a UUID generated in the browser's localStorage.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createServerSupabase();
    const { voter_id } = await request.json();

    if (!voter_id) {
      return NextResponse.json(
        { error: "voter_id is required" },
        { status: 400 },
      );
    }

    // Check if this voter already upvoted
    const { data: existing } = await supabase
      .from("plugin_upvotes")
      .select("id")
      .eq("plugin_id", id)
      .eq("voter_id", voter_id)
      .single();

    if (existing) {
      // Already upvoted — remove the upvote (toggle off)
      await supabase.from("plugin_upvotes").delete().eq("id", existing.id);

      // Decrement the counter
      const { data: plugin } = await supabase
        .from("plugins")
        .select("upvotes")
        .eq("id", id)
        .single();

      if (plugin) {
        await supabase
          .from("plugins")
          .update({ upvotes: Math.max(0, (plugin.upvotes ?? 0) - 1) })
          .eq("id", id);
      }

      return NextResponse.json({ upvoted: false });
    }

    // New upvote
    const { error } = await supabase
      .from("plugin_upvotes")
      .insert({ plugin_id: id, voter_id });

    if (error) {
      // Unique constraint violation means they already upvoted (race condition)
      if (error.code === "23505") {
        return NextResponse.json({ upvoted: true });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Increment the counter
    const { data: plugin } = await supabase
      .from("plugins")
      .select("upvotes")
      .eq("id", id)
      .single();

    if (plugin) {
      await supabase
        .from("plugins")
        .update({ upvotes: (plugin.upvotes ?? 0) + 1 })
        .eq("id", id);
    }

    return NextResponse.json({ upvoted: true });
  } catch (err) {
    console.error("POST /api/plugins/[id]/upvote error:", err);
    return NextResponse.json(
      { error: "Failed to toggle upvote" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/plugins/:id/upvote?vid=xxx — check if a voter has upvoted.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const voter_id = searchParams.get("vid");

    if (!voter_id) {
      return NextResponse.json({ upvoted: false });
    }

    const supabase = await createServerSupabase();
    const { data } = await supabase
      .from("plugin_upvotes")
      .select("id")
      .eq("plugin_id", id)
      .eq("voter_id", voter_id)
      .single();

    return NextResponse.json({ upvoted: !!data });
  } catch (err) {
    console.error("GET /api/plugins/[id]/upvote error:", err);
    return NextResponse.json({ upvoted: false });
  }
}
