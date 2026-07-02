"use client";

import Link from "next/link";
import { useAuth } from "./AuthProvider";
import { signOut } from "@/lib/auth";
import { useState } from "react";

export function UserMenu() {
  const { user, loading } = useAuth();
  const [open, setOpen] = useState(false);

  if (loading) {
    return (
      <span className="font-mono text-[11px] text-signal-low">…</span>
    );
  }

  if (!user) return null;

  const avatarUrl = user.user_metadata?.avatar_url;
  const username = user.user_metadata?.user_name ?? user.email ?? "user";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="h-6 w-6 flex items-center gap-2 rounded-full ring-1 ring-grid-bounds transition hover:ring-signal-high/50"
        aria-label={`${username} menu`}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="rounded-full"
          />
        ) : (
          <div className="flex items-center justify-center rounded-full bg-bg-surface text-[9px] text-zinc-300">
            {username.charAt(0).toUpperCase()}
          </div>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-48 bg-bg-surface ring-1 ring-grid-bounds">
          <div className="border-b border-grid-bounds/40 px-3 py-2">
            <p className="truncate font-mono text-[11px] text-zinc-300">
              {username}
            </p>
          </div>
          <div className="py-1">
            <DropdownLink href="/account/plugins" label="my plugins" />
            <DropdownLink href="/plugins/submit" label="submit a plugin" />
            <button
              onClick={async () => {
                await signOut();
                window.location.href = "/";
              }}
              className="flex w-full px-3 py-1.5 text-left font-mono text-[11px] lowercase text-signal-low transition hover:bg-bg-core hover:text-signal-high"
            >
              sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DropdownLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="block px-3 py-1.5 font-mono text-[11px] lowercase text-signal-low transition hover:bg-bg-core hover:text-signal-high"
    >
      {label}
    </Link>
  );
}
