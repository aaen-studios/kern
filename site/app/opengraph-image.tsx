import { ImageResponse } from "next/og";

// Build-time OG image — near-black bg, radar glyph motif, mono font.
// Statically optimized at build time by default.
export const alt = "kern — lightweight extensible server panel host";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  // render concentric rings of dots as SVG circles
  const rings = [120, 180, 240, 300];
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
          position: "relative",
        }}
      >
        {/* radar glyph */}
        <svg
          width="360"
          height="360"
          viewBox="0 0 360 360"
          style={{ position: "absolute", opacity: 0.9 }}
        >
          <rect
            x="30"
            y="30"
            width="300"
            height="300"
            rx="66"
            fill="#0b0c10"
          />
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
        <div
          style={{
            marginTop: "330px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <div
            style={{
              fontSize: 64,
              color: "#ededed",
              textTransform: "lowercase",
              letterSpacing: -1,
            }}
          >
            kern
          </div>
          <div
            style={{
              fontSize: 22,
              color: "#4c525e",
              textTransform: "lowercase",
              marginTop: 8,
            }}
          >
            any server. one panel.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
