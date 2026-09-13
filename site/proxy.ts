import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Proxy that validates the Supabase session on every request and refreshes
 * the auth cookies when the access token is near expiry.
 *
 * Uses getClaims() — the JWT signature is verified locally against the
 * project's published keys (JWKS), so the request path doesn't pay a round
 * trip to the Auth server. Cache headers emitted alongside refreshed cookies
 * are applied to the response so CDNs can't cache one user's session.
 *
 * Only runs on routes that need session awareness (not static assets).
 */
export async function proxy(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase isn't configured, skip proxy entirely
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // Verify the JWT locally; refreshes the session when the token is expiring.
  // Failures are non-fatal: protected routes re-check auth themselves.
  try {
    await supabase.auth.getClaims();
  } catch (err) {
    console.warn("proxy: getClaims failed", err);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (robots.txt, etc.)
     * - opengraph-image (OG image generation)
     */
    "/((?!_next/static|_next/image|favicon.ico|opengraph-image|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
