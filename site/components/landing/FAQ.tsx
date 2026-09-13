import { Section } from "@/components/ui/Section";
import { SectionHeading, Reveal } from "@/components/ui/Reveal";
import { FAQ_ITEMS } from "@/lib/faq";

/*
  FAQ — native <details> accordion (keyboard + screen-reader behaviour for
  free), kern voice answers. The same content feeds FAQPage JSON-LD from
  the server page.
*/
export function FAQ() {
  return (
    <Section width="prose">
      <Reveal>
        <SectionHeading kicker="faq" title="asked, answered.">
          the short version. if something&rsquo;s missing, open an issue.
        </SectionHeading>
      </Reveal>

      <div className="divide-y divide-grid-bounds/50 border-y border-grid-bounds/50">
        {FAQ_ITEMS.map((item, i) => (
          <Reveal key={item.q} delay={0.04 * Math.min(i, 5)}>
            <details className="group">
              <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4 py-4 font-mono text-xs lowercase text-zinc-200 transition-colors hover:text-signal-high [&::-webkit-details-marker]:hidden">
                <span>
                  <span className="mr-2 text-signal-low">?</span>
                  {item.q}
                </span>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-signal-low transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="pb-4 pl-5 pr-8 font-mono text-xs leading-relaxed text-signal-low">
                {item.a}
              </p>
            </details>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
