import { Section } from "@/components/ui/Section";
import { Panel } from "@/components/ui/Panel";
import { SectionHeading, Reveal } from "@/components/ui/Reveal";

/*
  Comparison — kern against the game-panel incumbents, plus the honest
  "not yet" row. Symbols carry a text label for screen readers; the kern
  column is the only highlighted one.
*/

type Verdict = "yes" | "no" | "partial" | "soon";

const CELL: Record<Verdict, { glyph: string; text: string; className: string }> = {
  yes: { glyph: "●", text: "yes", className: "text-signal-high" },
  no: { glyph: "○", text: "no", className: "text-signal-low/60" },
  partial: { glyph: "◐", text: "partial", className: "text-warn-vector" },
  soon: { glyph: "◌", text: "not yet", className: "text-signal-low" },
};

const COLUMNS = [
  { key: "kern", label: "kern" },
  { key: "pterodactyl", label: "pterodactyl" },
  { key: "amp", label: "amp" },
  { key: "pufferpanel", label: "pufferpanel" },
  { key: "crafty", label: "crafty" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

const ROWS: Array<{ label: string; values: Record<ColumnKey, Verdict> }> = [
  {
    label: "free to run",
    values: { kern: "yes", pterodactyl: "yes", amp: "partial", pufferpanel: "yes", crafty: "yes" },
  },
  {
    label: "open source",
    values: { kern: "yes", pterodactyl: "yes", amp: "no", pufferpanel: "yes", crafty: "yes" },
  },
  {
    label: "native desktop app",
    values: { kern: "yes", pterodactyl: "no", amp: "yes", pufferpanel: "no", crafty: "partial" },
  },
  {
    label: "runs any folder, not just games",
    values: { kern: "yes", pterodactyl: "partial", amp: "partial", pufferpanel: "partial", crafty: "no" },
  },
  {
    label: "plugin sdk for server types",
    values: { kern: "yes", pterodactyl: "partial", amp: "yes", pufferpanel: "no", crafty: "no" },
  },
  {
    label: "cli + automation api",
    values: { kern: "yes", pterodactyl: "partial", amp: "partial", pufferpanel: "partial", crafty: "partial" },
  },
  {
    label: "backups + crash watchdog",
    values: { kern: "yes", pterodactyl: "partial", amp: "yes", pufferpanel: "partial", crafty: "yes" },
  },
  {
    label: "phone control",
    values: { kern: "yes", pterodactyl: "yes", amp: "yes", pufferpanel: "yes", crafty: "yes" },
  },
  {
    label: "hosted multi-user web panel",
    values: { kern: "soon", pterodactyl: "yes", amp: "yes", pufferpanel: "yes", crafty: "yes" },
  },
];

export function ComparisonTable() {
  return (
    <Section>
      <Reveal>
        <SectionHeading kicker="comparison" title="pick the panel that fits.">
          the incumbents are built to host other people&rsquo;s servers on your
          hardware. kern is built to run yours on your machine — desktop
          native, plugin-driven, local-first.
        </SectionHeading>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr>
                <th className="border-b border-grid-bounds px-3 py-3 font-mono text-[11px] font-normal lowercase text-signal-low">
                  capability
                </th>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className={`border-b px-3 py-3 text-center font-mono text-[11px] font-normal lowercase ${
                      col.key === "kern"
                        ? "border-signal-high/40 bg-signal-high/5 text-signal-high"
                        : "border-grid-bounds text-signal-low"
                    }`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.label}>
                  <th
                    scope="row"
                    className="border-b border-grid-bounds/50 px-3 py-2.5 font-mono text-[11px] font-normal lowercase text-zinc-300"
                  >
                    {row.label}
                  </th>
                  {COLUMNS.map((col) => {
                    const cell = CELL[row.values[col.key]];
                    return (
                      <td
                        key={col.key}
                        className={`border-b border-grid-bounds/50 px-3 py-2.5 text-center font-mono text-[11px] lowercase ${
                          col.key === "kern" ? "bg-signal-high/5" : ""
                        }`}
                      >
                        <span className={cell.className} aria-hidden="true">
                          {cell.glyph}
                        </span>
                        <span className="sr-only">{cell.text}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>

      <Reveal delay={0.15}>
        <Panel className="mt-4 px-3 py-2">
          <p className="font-mono text-[10px] lowercase text-signal-low/70">
            directional comparison, late 2026 · corrections welcome via github
            issues
          </p>
        </Panel>
      </Reveal>
    </Section>
  );
}
