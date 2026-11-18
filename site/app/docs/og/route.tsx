import { getDocBySlug } from "@/lib/docs";
import { renderOgImage } from "@/lib/og";

/*
  /docs/og?slug=<doc> — per-doc OG images.

  They can't be colocated as opengraph-image.tsx inside the docs `[[...slug]]`
  segment (Next requires an optional catch-all to be the last URL part), so
  the docs metadata points here instead.
*/

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug") ?? "overview";
  const doc = getDocBySlug(slug);

  return renderOgImage({
    title: doc?.title ?? "kern docs",
    subtitle: doc?.description ?? "documentation for kern",
    headers: {
      "cache-control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
