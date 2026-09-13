import { SectionHeading, Reveal } from "@/components/ui/Reveal";
import { StatusDots } from "@/components/ui/StatusDots";

/*
  §9.2 — Roadmap. A short, honest list: what shipped, what's next.
  Public GitHub Projects/Issues link.
*/
const ITEMS: Array<{
  label: string;
  status: "wave" | "breathe" | "idle";
  note: string;
}> = [
  // shipped
  {
    label: "plugin marketplace",
    status: "wave",
    note: "browse + install from this registry inside kern",
  },
  {
    label: "macos + linux builds",
    status: "wave",
    note: "dmg · appimage — every platform self-updates",
  },
  {
    label: "kern-cli v2",
    status: "wave",
    note: "tui + scriptable automation: backups, tasks, webhooks",
  },
  {
    label: "web remote over cloudflare tunnel",
    status: "wave",
    note: "full panel: console, files, backups + quick/named tunnels",
  },
  // next
  {
    label: "plugin signing",
    status: "idle",
    note: "sha256 integrity ships; author signatures next",
  },
  {
    label: "backup/restore for more server types",
    status: "idle",
    note: "minecraft ships today; more runtimes next",
  },
  {
    label: "telemetry history + charts",
    status: "idle",
    note: "beyond live readouts",
  },
  {
    label: "headless / daemon mode",
    status: "idle",
    note: "run without the tray ui",
  },
  {
    label: "linux .deb packages",
    status: "idle",
    note: "appimage today",
  },
];

const STATUS_LABEL: Record<"wave" | "breathe" | "idle", string> = {
  wave: "shipped",
  breathe: "in progress",
  idle: "planned",
};

export function RoadmapStrip() {
  return (
    <section className="mx-auto max-w-[1080px] px-4 py-24 sm:px-6">
      <Reveal>
        <SectionHeading kicker="roadmap" title="what&rsquo;s next. honestly.">
          no fake dates. shipped work stays on the list; the rest is tracked in
          the open on github.
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
                  label={STATUS_LABEL[it.status]}
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
