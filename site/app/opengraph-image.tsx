import { renderOgImage, ogSize, ogContentType } from "@/lib/og";

// Root OG image — the site-wide fallback. Per-route images live next to
// their segments (app/docs/…, app/plugins/[id]/…).
export const alt = "kern — any server. one panel.";
export const size = ogSize;
export const contentType = ogContentType;

export default function Image() {
  return renderOgImage({
    title: "kern",
    subtitle: "any server. one panel.",
  });
}
