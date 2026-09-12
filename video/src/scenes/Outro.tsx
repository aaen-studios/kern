import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS } from "../theme";
import { polarRadar, seededRandom } from "../lib/shaders";
import { DotGrid } from "../components/DotGrid";
import { RadarGlyph } from "../components/RadarGlyph";
import { Wordmark } from "../components/Wordmark";
import { fontFamily } from "../fonts";

/**
 * Outro (~5s / 150 frames).
 * Field dims, radar glyph centers and holds, wordmark + tagline resolve,
 * then the repo URL appears. Final beat: everything holds on the lockup.
 */
export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cols = 96;
  const rows = 54;
  const buffer = polarRadar({
    cols,
    rows,
    frame,
    cpu: 0,
    random: seededRandom(404),
  });
  const bgOpacity = interpolate(frame, [0, 14], [0, 0.35], {
    extrapolateRight: "clamp",
  });

  const glyphEnter = spring({
    frame: frame - 6,
    fps,
    config: { damping: 200, mass: 1, stiffness: 85 },
    durationInFrames: 20,
  });
  const glyphScale = interpolate(glyphEnter, [0, 1], [0.7, 1]);

  const urlFade = interpolate(frame, [58, 76], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: COLORS.bgCore,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 56,
      }}
    >
      <div style={{ position: "absolute", inset: 0, opacity: bgOpacity }}>
        <DotGrid
          buffer={buffer}
          cols={cols}
          rows={rows}
          width={1920}
          height={1080}
          dotRadius={1.2}
        />
      </div>

      <RadarGlyph
        size={220}
        ignite={glyphEnter}
        sweep
        style={{ transform: `scale(${glyphScale})` }}
      />

      <Wordmark
        enterFrame={24}
        size={140}
        tagline="any server. one panel."
        taglineSize={44}
        taglineFrame={60}
      />

      <div
        style={{
          fontFamily,
          color: COLORS.signalLow,
          fontSize: 28,
          letterSpacing: "0.06em",
          opacity: urlFade,
          textTransform: "lowercase",
          marginTop: 8,
        }}
      >
        github.com/aaen-studios/kern
      </div>
    </div>
  );
};
