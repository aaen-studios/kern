"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavGroup } from "@/lib/docs";

/*
  Docs sidebar nav. Client-only for the active state — the server layout
  stays a server component and just passes the nav groups through.
*/
export function DocNav({ nav }: { nav: NavGroup[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="docs">
      {nav.map((group) => (
        <div key={group.group} className="mb-5">
          <h2 className="mb-2 font-mono text-[11px] lowercase text-signal-low">
            {group.group}
          </h2>
          <ul className="space-y-0.5">
            {group.docs.map((doc) => {
              const href = `/docs/${doc.slug}`;
              const active =
                pathname === href || (doc.slug === "overview" && pathname === "/docs");
              return (
                <li key={doc.slug}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`block border-l-2 px-2 py-1 font-mono text-[11px] lowercase transition-colors ${
                      active
                        ? "border-signal-high bg-bg-surface text-signal-high"
                        : "border-transparent text-zinc-300 hover:bg-bg-surface hover:text-signal-high"
                    }`}
                  >
                    {doc.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
