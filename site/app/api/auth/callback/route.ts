import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * OAuth callback — GitHub redirects here after the user authorizes.
 * We exchange the auth code for a session, then redirect to the homepage.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const cookieStore = await cookies();

    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        },
      },
    });

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // After a successful exchange, ensure the user has a profile row
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        await ensureProfile(user, supabase);
      }
    }
  }

  // Redirect back to the app
  return NextResponse.redirect(`${origin}${next}`);
}

/**
 * Helper: create a profile row if one doesn't exist yet for this user.
 * Inline here to avoid a circular dependency with lib/auth.
 */
async function ensureProfile(
  user: { id: string; identities?: { identity_data?: Record<string, unknown> }[]; email?: string },
  supabase: ReturnType<typeof createServerClient>,
) {
  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .single();

  if (existing) return;

  const identity = user.identities?.[0]?.identity_data;
  const githubUser = (identity?.user_name as string) ?? user.email?.split("@")[0] ?? "unknown";
  const githubAvatar = (identity?.avatar_url as string) ?? null;
  const githubUrl = (identity?.html_url as string) ?? `https://github.com/${githubUser}`;

  await supabase.from("profiles").insert({
    id: user.id,
    github_user: githubUser,
    github_avatar: githubAvatar,
    github_url: githubUrl,
  });
}
