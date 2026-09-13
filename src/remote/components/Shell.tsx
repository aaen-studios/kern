import type { ReactNode } from "react";
import { navigate } from "../lib/router";
import type { SseStatus } from "../lib/sse";
import type { AuthUser } from "../lib/types";

const NAV = [
  { key: "overview", label: "overview", glyph: "▦" },
  { key: "audit", label: "audit", glyph: "≣" },
  { key: "settings", label: "settings", glyph: "⚙" },
];

const PLUGINS_NAV = { key: "plugins", label: "plugins", glyph: "❖" };

export function Shell({
  user,
  section,
  conn,
  children,
}: {
  user: AuthUser;
  section: string;
  conn: SseStatus;
  children: ReactNode;
}) {
  const active = section === "s" ? "overview" : section;
  const nav = user.role === "admin" ? [...NAV, PLUGINS_NAV] : NAV;
  const connClass =
    conn === "live" ? "text-signal-high" : conn === "offline" ? "text-fault-vector" : "text-zinc-600";

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      {/* desktop sidebar */}
      <aside className="hidden lg:flex lg:h-screen lg:w-56 lg:shrink-0 lg:flex-col lg:gap-5 lg:border-r lg:border-grid-bounds lg:p-4 lg:sticky lg:top-0">
        <button
          onClick={() => navigate("/overview")}
          className="flex items-center gap-2 text-left"
        >
          <span className="h-2 w-2 rounded-full bg-signal-high shadow-[0_0_8px] shadow-signal-high" />
          <span className="font-mono text-sm tracking-[0.3em] uppercase text-zinc-100">
            kern
          </span>
          <span className="font-mono text-[10px] tracking-[0.2em] text-zinc-500">remote</span>
        </button>

        <nav className="flex flex-col gap-0.5">
          {nav.map((item) => (
            <button
              key={item.key}
              onClick={() => navigate(`/${item.key}`)}
              className={`border-l-2 px-3 py-2 text-left font-mono text-xs lowercase ${
                active === item.key
                  ? "border-signal-high bg-bg-surface text-signal-high"
                  : "border-transparent text-zinc-500 hover:text-zinc-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-1">
          <span className="font-mono text-[11px] text-zinc-400">
            {user.name} <span className="text-zinc-600">· {user.role}</span>
          </span>
          <span className={`font-mono text-[10px] uppercase tracking-[0.15em] ${connClass}`}>
            {conn === "live" ? "live" : conn === "offline" ? "offline" : "connecting"}
          </span>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 pb-24 pt-4 sm:px-6 lg:pb-10 lg:pt-6">
        {children}
      </main>

      {/* mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-grid-bounds bg-bg-core/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {nav.map((item) => (
          <button
            key={item.key}
            onClick={() => navigate(`/${item.key}`)}
            className={`flex flex-1 flex-col items-center gap-1 py-2.5 font-mono text-[10px] lowercase ${
              active === item.key ? "text-signal-high" : "text-zinc-500"
            }`}
          >
            <span className="text-base leading-none">{item.glyph}</span>
            {item.label}
          </button>
        ))}
        <span
          className={`absolute right-3 top-2 h-1.5 w-1.5 rounded-full ${
            conn === "live"
              ? "bg-signal-high"
              : conn === "offline"
                ? "bg-fault-vector"
                : "bg-signal-low"
          }`}
        />
      </nav>
    </div>
  );
}
