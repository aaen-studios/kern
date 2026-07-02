import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so Turbopack doesn't mis-infer it from a stray
  // parent-dir lockfile. Keeps the build quiet; no other config needed.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
