"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { KernWordmark } from "@/components/brand/RadarMark";

const NAV_LINKS = [
  { href: "/#features", label: "features" },
  { href: "/plugins", label: "plugins" },
  { href: "/docs", label: "docs" },
  { href: "/changelog", label: "changelog" },
];

export function StickyNav() {
  // Fades in opacity as you scroll (tied to scrollY).
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        scrolled
          ? "bg-bg-core/85 backdrop-blur-sm border-b border-grid-bounds/60"
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-14 max-w-[1080px] items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          className="focus-visible:outline-2 focus-visible:outline-offset-2"
          aria-label="kern — home"
        >
          <KernWordmark />
        </Link>

        <div className="flex items-center gap-1 sm:gap-4">
          <ul className="hidden items-center gap-5 sm:flex">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="font-mono text-xs lowercase text-signal-low transition-colors hover:text-signal-high"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href="/#download"
            className="inline-flex items-center bg-signal-high px-3 py-1.5 font-mono text-xs lowercase text-bg-core transition hover:brightness-110"
          >
            download
          </Link>
        </div>
      </nav>
    </header>
  );
}
