import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/plugins/:id — single plugin detail with versions.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createServerSupabase();

    // Try slug first, fall back to UUID
    let { data: plugin, error } = await supabase
      .from("plugins")
      .select(`
        *,
        profiles:author_id (
          github_user,
          github_avatar,
          github_url
        ),
        plugin_versions (*)
      `)
      .eq("slug", id)
      .single();

    if (!plugin) {
      const { data: fallback, error: fallbackError } = await supabase
        .from("plugins")
        .select(`
          *,
          profiles:author_id (
            github_user,
            github_avatar,
            github_url
          ),
          plugin_versions (*)
        `)
        .eq("id", id)
        .single();
      plugin = fallback ?? null;
      error = fallbackError;
    }

    if (error || !plugin) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }

    return NextResponse.json({
      ...plugin,
      author_github: plugin.profiles?.github_user ?? null,
      author_avatar: plugin.profiles?.github_avatar ?? null,
      profiles: undefined,
    });
  } catch (err) {
    console.error("GET /api/plugins/[id] error:", err);
    return NextResponse.json(
      { error: "Failed to fetch plugin" },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/plugins/:id — update plugin metadata (owner only).
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
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

    const body = await request.json();
    const allowedFields = [
      "display_name",
      "description",
      "category",
      "tags",
      "repo_url",
      "homepage_url",
      "readme_md",
      "config_schema",
      "screenshots",
    ];

    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("plugins")
      .update(updates)
      .eq("id", pluginUuid)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error("PUT /api/plugins/[id] error:", err);
    return NextResponse.json(
      { error: "Failed to update plugin" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/plugins/:id — delete plugin and its versions (owner only).
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
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

    // Delete versions first, then the plugin
    await supabase.from("plugin_versions").delete().eq("plugin_id", pluginUuid);
    const { error } = await supabase.from("plugins").delete().eq("id", pluginUuid);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/plugins/[id] error:", err);
    return NextResponse.json(
      { error: "Failed to delete plugin" },
      { status: 500 },
    );
  }
}
