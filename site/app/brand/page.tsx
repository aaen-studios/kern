import type { Metadata } from "next";
import { RadarMark, KernWordmark } from "@/components/brand/RadarMark";
import { StatusDots } from "@/components/ui/StatusDots";
import { Reveal, SectionHeading } from "@/components/ui/Reveal";
import { MatrixDivider } from "@/components/ui/MatrixBorder";

export const metadata: Metadata = {
  title: "brand",
  description:
    "the kern signal-radar design system — the mark, the colour tokens, the dot grammar, the voice. one family, lowercase, always.",
};

/*
  /brand — the design system as a product artifact. Documents the Signal Radar
  identity from WEBSITE_MASTER_PROMPT.md §3: the mark, the seven semantic
  colour tokens, the dot grammar, typography, the dotted-matrix motif, and the
  kern voice. Live demos of RadarMark + StatusDots alongside the spec.
*/

const COLOUR_TOKENS = [
  {
    name: "bg-core",
    hex: "#050506",
    swatch: "#050506",
    meaning: "absolute base background. near-black. page background.",
    ring: true,
  },
  {
    name: "bg-surface",
    hex: "#0b0c10",
    swatch: "#0b0c10",
    meaning: "cards, panels, elevated surfaces.",
    ring: true,
  },
  {
    name: "grid-bounds",
    hex: "#161920",
    swatch: "#161920",
    meaning: "inactive dots, dotted dividers, scrollbar thumbs.",
    ring: true,
  },
  {
    name: "signal-high",
    hex: "#4cf5a0",
    swatch: "#4cf5a0",
    meaning: "primary brand accent — signal green. running / active / cta.",
  },
  {
    name: "signal-low",
    hex: "#4c525e",
    swatch: "#4c525e",
    meaning: "standby / offline / muted text.",
  },
  {
    name: "warn-vector",
    hex: "#f5a04c",
    swatch: "#f5a04c",
    meaning: "warnings / transitional states. amber.",
  },
  {
    name: "fault-vector",
    hex: "#f54c4c",
    swatch: "#f54c4c",
    meaning: "errors / terminated. crimson.",
  },
];

const VOICE_RULES = [
  ["lowercase", "always. headings, body, nav, buttons. capitals only in code/identifiers."],
  ["terse", "short declarative sentences. often fragments. no marketing fluff."],
  ["technical", "real domain nouns: instance, registry, reactor, lifecycle, orphan, latest.log."],
  ["honest", "understated confidence. \"no fake dates. tracked in the open.\""],
  ["no hype", "no exclamation marks. no superlatives. the panel never lies."],
];

const VOICE_EXAMPLES = [
  "any server. one panel.",
  "stream stdout. pipe stdin.",
  "start. stop. restart. gracefully.",
  "updates itself. signed.",
  "signal lost",
  "no instances registered",
];

export default function BrandPage() {
  return (
    <main className="mx-auto max-w-[820px] px-4 pb-24 pt-28 sm:px-6">
      <Reveal>
        <header className="mb-10">
          <p className="font-mono text-xs lowercase text-signal-low">
            {"// "}brand
          </p>
          <h1 className="mt-2 font-mono text-3xl font-bold lowercase text-zinc-100">
            signal radar
          </h1>
          <p className="mt-3 font-mono text-xs text-signal-low">
            the kern design system. one family, lowercase, always. colour is
            strictly semantic — never decorative, never invented. the whole
            interface is an instrument panel, not a marketing site.
          </p>
        </header>
      </Reveal>

      <Reveal delay={0.05}>
        <MatrixDivider className="mb-12 opacity-60" />
      </Reveal>

      {/* ── the mark ─────────────────────────────────────────────── */}
      <Reveal>
        <SectionHeading kicker="identity" title="the mark.">
          a glowing green signal-radar / emission-core. a bright signal-green
          core with concentric rings of green dots on a near-black rounded
          square, with a soft green radial bloom. the simplified single-ring
          variant is used at small sizes.
        </SectionHeading>
      </Reveal>

      <Reveal delay={0.1}>
        <div
          className="mb-12 grid grid-cols-3 gap-4 p-8"
          style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
        >
          <div className="flex flex-col items-center gap-3">
            <RadarMark size="sm" />
            <span className="font-mono text-[10px] lowercase text-signal-low">
              sm · 20px
            </span>
          </div>
          <div className="flex flex-col items-center gap-3">
            <RadarMark size="md" />
            <span className="font-mono text-[10px] lowercase text-signal-low">
              md · 28px
            </span>
          </div>
          <div className="flex flex-col items-center gap-3">
            <RadarMark size="lg" />
            <span className="font-mono text-[10px] lowercase text-signal-low">
              lg · 48px
            </span>
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mb-16 flex items-center justify-center gap-8 p-6 bg-bg-core/60">
          <KernWordmark />
          <span className="font-mono text-[10px] lowercase text-signal-low">
            wordmark
          </span>
        </div>
      </Reveal>

      {/* ── colour ───────────────────────────────────────────────── */}
      <Reveal>
        <SectionHeading kicker="colour tokens" title="seven hues. no others.">
          green = running / active / cta. amber = transitional / warn. crimson =
          error. gray = standby. every colour carries meaning; none are
          decorative. body text defaults to zinc-300 over bg-core.
        </SectionHeading>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mb-16 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-grid-bounds">
                <th className="py-2 pr-3 font-mono text-[10px] lowercase text-signal-low">
                  token
                </th>
                <th className="py-2 pr-3 font-mono text-[10px] lowercase text-signal-low">
                  hex
                </th>
                <th className="py-2 pr-3 font-mono text-[10px] lowercase text-signal-low">
                  meaning
                </th>
              </tr>
            </thead>
            <tbody>
              {COLOUR_TOKENS.map((t) => (
                <tr key={t.name} className="border-b border-grid-bounds/50">
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-3.5 w-3.5 shrink-0"
                        style={{
                          background: t.swatch,
                          boxShadow: t.ring
                            ? "inset 0 0 0 1px rgba(76,82,94,0.6)"
                            : "none",
                        }}
                      />
                      <span className="font-mono text-xs lowercase text-zinc-200">
                        {t.name}
                      </span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-[11px] text-signal-low">
                    {t.hex}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-[11px] text-signal-low">
                    {t.meaning}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>

      {/* ── dot grammar ──────────────────────────────────────────── */}
      <Reveal>
        <SectionHeading kicker="dot grammar" title="status as light.">
          status is rendered as arrays of light-emitting micro-nodes driven by
          pure-math shader functions. each state has a colour and an animation:
        </SectionHeading>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mb-16 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div
            className="flex flex-col gap-2 bg-bg-core p-5"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            <div className="flex items-center justify-between">
              <StatusDots status="wave" label="running" count={5} />
              <span className="font-mono text-[10px] text-signal-high">
                wave
              </span>
            </div>
            <p className="font-mono text-[11px] text-signal-low">
              signal-green, traveling wave. running / active.
            </p>
          </div>
          <div
            className="flex flex-col gap-2 bg-bg-core p-5"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            <div className="flex items-center justify-between">
              <StatusDots status="breathe" label="starting" count={5} />
              <span className="font-mono text-[10px] text-warn-vector">
                breathe
              </span>
            </div>
            <p className="font-mono text-[11px] text-signal-low">
              amber, slow breathe. starting / installing.
            </p>
          </div>
          <div
            className="flex flex-col gap-2 bg-bg-core p-5"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            <div className="flex items-center justify-between">
              <StatusDots status="blink" label="fault" count={5} />
              <span className="font-mono text-[10px] text-fault-vector">
                blink
              </span>
            </div>
            <p className="font-mono text-[11px] text-signal-low">
              crimson, rapid blink. error / terminated.
            </p>
          </div>
          <div
            className="flex flex-col gap-2 bg-bg-core p-5"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            <div className="flex items-center justify-between">
              <StatusDots status="idle" label="standby" count={5} />
              <span className="font-mono text-[10px] text-signal-low">
                idle
              </span>
            </div>
            <p className="font-mono text-[11px] text-signal-low">
              gray, static. standby / offline.
            </p>
          </div>
        </div>
      </Reveal>

      {/* ── typography ───────────────────────────────────────────── */}
      <Reveal>
        <SectionHeading kicker="typography" title="one family. mono always.">
          jetbrains mono everywhere. no sans-serif, no serifs. base 13px,
          line-height 1.4, antialiased. headings are the same family, lowercase
          and terse.
        </SectionHeading>
      </Reveal>

      <Reveal delay={0.1}>
        <div
          className="mb-12 flex flex-col gap-4 p-6"
          style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
        >
          <div className="flex items-baseline gap-4">
            <span className="font-mono text-2xl font-bold lowercase text-zinc-100">
              signal acquired
            </span>
            <span className="font-mono text-[10px] text-signal-low">
              bold · 700 · 24px
            </span>
          </div>
          <div className="flex items-baseline gap-4">
            <span className="font-mono text-lg font-medium lowercase text-zinc-100">
              section heading
            </span>
            <span className="font-mono text-[10px] text-signal-low">
              medium · 500 · 18px
            </span>
          </div>
          <div className="flex items-baseline gap-4">
            <span className="font-mono text-sm lowercase text-zinc-300">
              body text. running at the default weight.
            </span>
            <span className="font-mono text-[10px] text-signal-low">
              regular · 400 · 13px
            </span>
          </div>
          <div className="flex items-baseline gap-4">
            <span className="font-mono text-xs font-extralight lowercase text-signal-low">
              {"// "}kicker · muted annotation
            </span>
            <span className="font-mono text-[10px] text-signal-low">
              extralight · 200 · 12px
            </span>
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <p className="mb-16 font-mono text-[11px] text-signal-low">
          note: jetbrains mono has no <code className="text-signal-high">wdth</code>{" "}
          (stretch) axis — it is fixed-width by nature. hierarchy is achieved
          through weight, size, and colour, never font-stretch.
        </p>
      </Reveal>

      {/* ── matrix motif ─────────────────────────────────────────── */}
      <Reveal>
        <SectionHeading kicker="boundaries" title="dotted matrix, not solid lines.">
          boundaries are dotted-matrix fills, not solid 1px borders — radial
          dots on a 6px tile. avoid solid borders except for focus rings, which
          are signal-green and must never be reset.
        </SectionHeading>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mb-16 flex flex-col gap-3">
          <div className="matrix-border h-px w-full opacity-70" />
          <div className="h-16 w-full matrix-grid-faint opacity-60" />
          <p className="font-mono text-[10px] text-signal-low">
            ↑ dotted divider (matrix-border) · dot-grid accent (matrix-grid-faint)
          </p>
        </div>
      </Reveal>

      {/* ── voice ────────────────────────────────────────────────── */}
      <Reveal>
        <SectionHeading kicker="voice" title="lowercase. terse. technical.">
          the kern voice is consistent across every surface. it reads like a
          console log, not a press release.
        </SectionHeading>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {VOICE_RULES.map(([rule, desc]) => (
            <div
              key={rule}
              className="flex flex-col gap-1 bg-bg-core p-4"
              style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
            >
              <span className="font-mono text-xs lowercase text-signal-high">
                {rule}
              </span>
              <span className="font-mono text-[11px] text-signal-low">
                {desc}
              </span>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mb-16">
          <p className="mb-3 font-mono text-[10px] lowercase text-signal-low">
            {"// "}in the wild
          </p>
          <div className="flex flex-col gap-2">
            {VOICE_EXAMPLES.map((ex) => (
              <p key={ex} className="font-mono text-sm lowercase text-zinc-300">
                {ex}
              </p>
            ))}
          </div>
        </div>
      </Reveal>

      <Reveal>
        <MatrixDivider className="mb-8 opacity-60" />
        <p className="font-mono text-[11px] lowercase text-signal-low">
          source of truth:{" "}
          <code className="text-signal-high">WEBSITE_MASTER_PROMPT.md §3</code>.
          reproduced faithfully in the tailwind theme and component library.
        </p>
      </Reveal>
    </main>
  );
}
