import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/plugins — list plugins with optional filters.
 * Query params: q, category, tag, author, verified, sort (popular|recent|upvotes)
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
    const { searchParams } = new URL(request.url);

    let query = supabase
      .from("plugins")
      .select(`
        *,
        profiles:author_id (
          github_user,
          github_avatar,
          github_url
        ),
        plugin_versions (*)
      `);

    // Text search on display_name and description
    const q = searchParams.get("q");
    if (q) {
      const sanitized = q.replace(/[%_]/g, ""); // prevent LIKE injection
      query = query.or(
        `display_name.ilike.%${sanitized}%,description.ilike.%${sanitized}%`,
      );
    }

    // Category filter
    const category = searchParams.get("category");
    if (category && category !== "all") {
      query = query.eq("category", category);
    }

    // Tag filter
    const tag = searchParams.get("tag");
    if (tag) {
      query = query.contains("tags", [tag]);
    }

    // Author filter
    const author = searchParams.get("author");
    if (author) {
      query = query.eq("profiles.github_user", author);
    }

    // Verified filter — plugins by `ellipog` (the official account)
    const verified = searchParams.get("verified");
    if (verified === "true") {
      query = query.eq("profiles.github_user", "ellipog");
    }

    // Sort
    const sort = searchParams.get("sort") ?? "popular";
    switch (sort) {
      case "recent":
        query = query.order("created_at", { ascending: false });
        break;
      case "upvotes":
        query = query.order("upvotes", { ascending: false });
        break;
      case "popular":
      default:
        query = query.order("install_count", { ascending: false });
        break;
    }

    const { data: plugins, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Flatten the joined profile into the response
    const result = (plugins ?? []).map((p) => ({
      ...p,
      author_github: p.profiles?.github_user ?? null,
      author_avatar: p.profiles?.github_avatar ?? null,
      profiles: undefined,
      versions: p.plugin_versions ?? [],
    }));

    return NextResponse.json(result);
  } catch (err) {
    console.error("GET /api/plugins error:", err);
    return NextResponse.json(
      { error: "Failed to fetch plugins" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/plugins — create a new plugin listing (requires auth).
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
    const { slug, display_name, description, category, tags, repo_url, homepage_url, readme_md } = body;

    // Validate required fields
    if (!slug || !display_name || !description || !category) {
      return NextResponse.json(
        { error: "slug, display_name, description, and category are required" },
        { status: 400 },
      );
    }

    // Check slug uniqueness
    const { data: existing } = await supabase
      .from("plugins")
      .select("id")
      .eq("slug", slug)
      .single();

    if (existing) {
      return NextResponse.json(
        { error: "A plugin with this slug already exists" },
        { status: 409 },
      );
    }

    const { data, error } = await supabase
      .from("plugins")
      .insert({
        slug,
        display_name,
        description,
        author_id: user.id,
        category,
        tags: tags ?? [],
        repo_url,
        homepage_url,
        readme_md: readme_md ?? "",
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    console.error("POST /api/plugins error:", err);
    return NextResponse.json(
      { error: "Failed to create plugin" },
      { status: 500 },
    );
  }
}
