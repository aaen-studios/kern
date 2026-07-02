import { createServerSupabase } from "@/lib/supabase-server";
import type { User } from "@supabase/supabase-js";

/**
 * Get the profile for a user, creating one if it doesn't exist.
 * This runs server-side and is called after OAuth sign-in.
 */
export async function ensureProfile(user: User) {
  const supabase = await createServerSupabase();

  // Check if profile already exists
  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .single();

  if (existing) return existing;

  // Extract GitHub metadata from the identity data
  const identity = user.identities?.[0]?.identity_data;
  const githubUser =
    (identity?.user_name as string) ??
    user.email?.split("@")[0] ??
    "unknown";
  const githubAvatar = (identity?.avatar_url as string) ?? null;
  const githubUrl = (identity?.html_url as string) ?? `https://github.com/${githubUser}`;

  // Create profile
  const { data, error } = await supabase
    .from("profiles")
    .insert({
      id: user.id,
      github_user: githubUser,
      github_avatar: githubAvatar,
      github_url: githubUrl,
    })
    .select()
    .single();

  if (error) {
    console.error("Failed to create profile:", error);
    return null;
  }

  return data;
}

export type Profile = {
  id: string;
  github_user: string;
  github_avatar: string | null;
  github_url: string | null;
  created_at: string;
};

/**
 * Fetch the profile for a given user ID.
 */
export async function getProfile(userId: string): Promise<Profile | null> {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  return data;
}

/**
 * Fetch a profile by GitHub username (for public publisher pages).
 */
export async function getProfileByUsername(
  githubUser: string,
): Promise<Profile | null> {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("github_user", githubUser)
    .single();
  return data;
}
