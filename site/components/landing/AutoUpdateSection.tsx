import { SectionHeading, Reveal } from "@/components/ui/Reveal";
import { StatusDots } from "@/components/ui/StatusDots";

/*
  §10.9 — Auto-update. "updates itself, signed." Short section.
  kern's desktop updater pulls releases/latest/download/update.json
  (minisign-signed). The website's download buttons are the manual fallback.
*/
export function AutoUpdateSection() {
  return (
    <section className="mx-auto max-w-[1080px] px-4 py-24 sm:px-6">
      <Reveal>
        <SectionHeading kicker="auto-update" title="updates itself. signed.">
          the in-app updater pulls minisign-signed archives from github releases.
          the website&rsquo;s download buttons are the manual fallback; the
          updater handles patching after that.
        </SectionHeading>
      </Reveal>

      <Reveal delay={0.1}>
        <div
          className="flex flex-col items-start gap-4 bg-bg-core p-6 sm:flex-row sm:items-center sm:justify-between"
          style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
        >
          <div className="flex items-center gap-4">
            <StatusDots status="breathe" label="checking for updates" count={4} />
            <div>
              <p className="font-mono text-xs lowercase text-zinc-200">
                checking releases/latest/download/update.json
              </p>
              <p className="mt-1 font-mono text-[11px] text-signal-low">
                signature verified · minisign · patch ready
              </p>
            </div>
          </div>
          <span className="inline-flex items-center bg-signal-high/10 px-3 py-1.5 font-mono text-[11px] lowercase text-signal-high ring-1 ring-signal-high/30">
            ✓ verified
          </span>
        </div>
      </Reveal>
    </section>
  );
}
