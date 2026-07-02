import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser (client-component) Supabase client.
 * Session is stored in httpOnly cookies automatically by @supabase/ssr.
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set",
    );
  }

  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
