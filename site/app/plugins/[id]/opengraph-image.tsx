import { getPlugin, latestVersion } from "@/lib/registry";
import { renderOgImage, ogSize, ogContentType } from "@/lib/og";

// Per-plugin OG image: display name + author/version line.
export const size = ogSize;
export const contentType = ogContentType;

export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const plugin = await getPlugin(id).catch(() => null);

  if (!plugin) {
    return renderOgImage({ title: id, subtitle: "kern plugin" });
  }

  const v = latestVersion(plugin);
  return renderOgImage({
    title: plugin.display_name,
    subtitle: `plugin · ${plugin.author_github ?? plugin.author} · v${v.version}`,
  });
}
