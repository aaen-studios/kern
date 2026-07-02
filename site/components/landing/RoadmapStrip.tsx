import { SectionHeading, Reveal } from "@/components/ui/Reveal";
import { StatusDots } from "@/components/ui/StatusDots";

/*
  §9.2 — Roadmap. A short, honest list. Public GitHub Projects/Issues link.
*/
const ITEMS: Array<{ label: string; status: "wave" | "breathe" | "idle"; note: string }> = [
  { label: "macos + linux signed builds", status: "breathe", note: "windows ships first" },
  { label: "in-app plugin browser", status: "idle", note: "consume this registry from inside kern" },
  { label: "plugin signing", status: "idle", note: "verified publishers" },
  { label: "backup/restore for more server types", status: "idle", note: "for all server types" },
  { label: "telemetry history + charts", status: "idle", note: "beyond live readouts" },
];

export function RoadmapStrip() {
  return (
    <section className="mx-auto max-w-[1080px] px-4 py-24 sm:px-6">
      <Reveal>
        <SectionHeading kicker="roadmap" title="what&rsquo;s next. honestly.">
          no fake dates. tracked in the open on github.
        </SectionHeading>
      </Reveal>
      <Reveal delay={0.1}>
        <ul className="divide-y divide-grid-bounds/50 border-y border-grid-bounds/50">
          {ITEMS.map((it) => (
            <li
              key={it.label}
              className="flex items-center justify-between gap-4 py-4"
            >
              <div className="flex items-center gap-4">
                <StatusDots
                  status={it.status}
                  label={it.status === "breathe" ? "in progress" : "planned"}
                  count={3}
                />
                <span className="font-mono text-sm lowercase text-zinc-200">
                  {it.label}
                </span>
              </div>
              <span className="font-mono text-[11px] text-signal-low">
                {it.note}
              </span>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}
