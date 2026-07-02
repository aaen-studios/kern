import Link from "next/link";
import { KernWordmark } from "@/components/brand/RadarMark";
import { MatrixDivider } from "@/components/ui/MatrixBorder";

const GITHUB = "https://github.com/ellipog/kern";

const COLUMNS = [
  {
    heading: "product",
    links: [
      { href: "/#features", label: "features" },
      { href: "/#download", label: "download" },
      { href: "/changelog", label: "changelog" },
      { href: "/plugins", label: "plugins" },
    ],
  },
  {
    heading: "develop",
    links: [
      { href: "/docs", label: "docs" },
      { href: "/docs/manifest-reference", label: "manifest" },
      { href: "/docs/plugin-ui", label: "plugin ui" },
      { href: "/docs/distribution", label: "distribution" },
    ],
  },
  {
    heading: "community",
    links: [
      { href: GITHUB, label: "github", external: true },
      { href: `${GITHUB}/discussions`, label: "discussions", external: true },
      { href: `${GITHUB}/issues`, label: "issues", external: true },
      { href: "#", label: "discord (soon)" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="mt-24 bg-bg-surface/40">
      <MatrixDivider />
      <div className="mx-auto max-w-[1080px] px-4 py-12 sm:px-6">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <KernWordmark />
            <p className="mt-3 max-w-xs font-mono text-[11px] leading-relaxed text-signal-low">
              lightweight extensible server panel host. turn any folder into a
              managed instance.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <h3 className="mb-3 font-mono text-[11px] lowercase text-signal-low">
                {col.heading}
              </h3>
              <ul className="space-y-2">
                {col.links.map((l) => (
                  <li key={l.label}>
                    {"external" in l && l.external ? (
                      <a
                        href={l.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs lowercase text-zinc-300 transition-colors hover:text-signal-high"
                      >
                        {l.label}
                      </a>
                    ) : (
                      <Link
                        href={l.href}
                        className="font-mono text-xs lowercase text-zinc-300 transition-colors hover:text-signal-high"
                      >
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <MatrixDivider className="my-8 opacity-50" />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[11px] lowercase text-signal-low">
            built with tauri · react · rust · tailwind
          </p>
          <p className="font-mono text-[11px] lowercase text-signal-low">
            © {new Date().getFullYear()} kern — mit license
          </p>
        </div>
      </div>
    </footer>
  );
}
