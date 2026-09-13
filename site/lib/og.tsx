import { ImageResponse } from "next/og";

/*
  Shared Open Graph image renderer — near-black bg, radar glyph motif,
  lowercase mono type. Used by the root OG and per-route OG images
  (docs, plugins) so the whole site shares one visual signature.
*/

export const ogSize = { width: 1200, height: 630 };
export const ogContentType = "image/png";

function RadarGlyph() {
  const rings = [120, 180, 240, 300];
  return (
    <svg width="260" height="260" viewBox="0 0 360 360">
      <rect x="30" y="30" width="300" height="300" rx="66" fill="#0b0c10" />
      {rings.map((r) =>
        Array.from({ length: Math.floor((2 * Math.PI * r) / 22) }).map(
          (_, i, arr) => {
            const a = (i / arr.length) * Math.PI * 2 - Math.PI / 2;
            return (
              <circle
                key={`${r}-${i}`}
                cx={180 + Math.cos(a) * r}
                cy={180 + Math.sin(a) * r}
                r={2.5}
                fill={r <= 180 ? "#1f3a2c" : "#15241c"}
              />
            );
          },
        ),
      )}
      <circle cx="180" cy="180" r="22" fill="#4cf5a0" />
    </svg>
  );
}

export function renderOgImage({
  title,
  subtitle,
  headers,
}: {
  title: string;
  subtitle: string;
  headers?: Record<string, string>;
}) {
  const fontSize = title.length > 34 ? 38 : title.length > 22 ? 46 : 56;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#050506",
          color: "#d4d4d8",
          fontFamily: "monospace",
          padding: 72,
        }}
      >
        <RadarGlyph />
        <div
          style={{
            marginTop: 32,
            fontSize,
            color: "#ededed",
            textTransform: "lowercase",
            letterSpacing: -1,
            display: "flex",
            textAlign: "center",
          }}
        >
          {title}
        </div>
        <div
          style={{
            marginTop: 12,
            fontSize: 22,
            color: "#4c525e",
            textTransform: "lowercase",
            display: "flex",
            textAlign: "center",
          }}
        >
          {subtitle}
        </div>
      </div>
    ),
    { ...ogSize, headers },
  );
}
