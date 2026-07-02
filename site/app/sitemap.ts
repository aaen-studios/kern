import type { MetadataRoute } from "next";
import { getAllDocs } from "@/lib/docs";
import { getPluginIds, getPublishers } from "@/lib/registry";

const BASE = "https://kern.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes = ["", "/plugins", "/docs", "/changelog"].map((path) => ({
    url: `${BASE}${path}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: path === "" ? 1 : 0.8,
  }));

  const docRoutes = getAllDocs().map((d) => ({
    url: `${BASE}/docs/${d.slug}`,
    lastModified: new Date(),
    changeFrequency: "monthly" as const,
    priority: 0.6,
  }));

  const pluginRoutes = getPluginIds().map((id) => ({
    url: `${BASE}/plugins/${id}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));

  const publisherRoutes = getPublishers().map((p) => ({
    url: `${BASE}/plugins/publishers/${encodeURIComponent(p.author)}`,
    lastModified: new Date(),
    changeFrequency: "monthly" as const,
    priority: 0.5,
  }));

  return [...staticRoutes, ...docRoutes, ...pluginRoutes, ...publisherRoutes];
}
