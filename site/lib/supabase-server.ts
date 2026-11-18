import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-component / API-route Supabase client.
 * Reads the session from the request cookies so auth state is preserved.
 */
export async function createServerSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set",
    );
  }

  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component render, where cookies are
          // read-only. The proxy refreshes and persists the session on the
          // way in, so this can be ignored.
        }
      },
    },
  });
}

/**
 * Returns the authenticated user id from the request's JWT, or null.
 *
 * Uses `getClaims()`: the JWT signature is verified locally against the
 * project's published keys (JWKS), so the request path doesn't pay a round
 * trip to the Auth server. Expired tokens are refreshed through the cookie
 * adapter, same as getUser().
 */
export async function getAuthenticatedUserId(
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return null;
    const sub = data.claims.sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}
