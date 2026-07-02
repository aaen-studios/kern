import { createClient } from "@/lib/supabase";

/**
 * Start GitHub OAuth sign-in.
 * Redirects the user to GitHub, then back to /api/auth/callback.
 */
export async function signInWithGitHub() {
  const supabase = createClient();

  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo: `${origin}/api/auth/callback`,
    },
  });

  if (error) throw error;
  return data;
}

/**
 * Sign out the current user.
 */
export async function signOut() {
  const supabase = createClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
