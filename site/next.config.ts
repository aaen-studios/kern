import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // route transitions via React's <ViewTransition> (progressive
    // enhancement — without browser support, navigation is instant)
    viewTransition: true,
  },
  // Pin the workspace root so Turbopack doesn't mis-infer it from a stray
  // parent-dir lockfile. Keeps the build quiet; no other config needed.
  turbopack: {
    root: __dirname,
    // vgpu shaders are authored as .wgsl modules; the loader resolves the
    // import graph at build time and hands effect() one finished shader.
    rules: {
      "*.wgsl": {
        loaders: ["@vgpu/wgsl/loader-webpack"],
        as: "*.js",
      },
    },
  },
  // Baseline hardening; HSTS is added by the platform (Vercel).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default nextConfig;
