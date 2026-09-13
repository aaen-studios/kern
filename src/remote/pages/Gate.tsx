import { useEffect, useState } from "react";
import { pairDevice, invitePreview } from "../lib/api";
import { deviceLabel, setSession } from "../lib/session";
import type { AuthUser } from "../lib/types";

interface InvitePreview {
  name: string;
  role: string;
  expiresAt: number;
  valid: boolean;
}

export function Gate({
  invite,
  onPaired,
}: {
  invite: string | null;
  onPaired: (user: AuthUser) => void;
}) {
  const [code, setCode] = useState(invite ?? "");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!invite) return;
    void invitePreview(invite).then(setPreview);
  }, [invite]);

  async function connect() {
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await pairDevice(code.trim(), deviceLabel());
      setSession(result.token);
      onPaired(result.user as AuthUser);
    } catch (err) {
      setError(err instanceof Error ? err.message : "pairing failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md border border-grid-bounds bg-bg-surface p-6">
        <div className="mb-5 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-signal-high shadow-[0_0_8px] shadow-signal-high" />
          <span className="font-mono text-sm tracking-[0.3em] uppercase text-zinc-100">
            kern
          </span>
          <span className="font-mono text-xs tracking-[0.2em] text-zinc-500">remote</span>
        </div>

        {invite && preview?.valid ? (
          <>
            <h1 className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-400">
              pair this device
            </h1>
            <p className="mt-2 font-mono text-xs text-zinc-500">
              invite for{" "}
              <span className="text-signal-high">{preview.name}</span> · {preview.role}
            </p>
            <button
              onClick={() => void connect()}
              disabled={busy}
              className="mt-5 w-full bg-signal-high px-4 py-2 font-mono text-xs font-semibold text-bg-core disabled:opacity-50"
            >
              {busy ? "pairing…" : "connect"}
            </button>
          </>
        ) : invite ? (
          <>
            <h1 className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-400">
              invite unavailable
            </h1>
            <p className="mt-2 font-mono text-xs text-zinc-500">
              this invite is expired or already used. ask for a fresh link.
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="invite code"
              className="mt-4 w-full border border-grid-bounds bg-bg-core px-3 py-2 font-mono text-xs uppercase tracking-widest text-zinc-100"
            />
            <button
              onClick={() => void connect()}
              disabled={busy || !code.trim()}
              className="mt-3 w-full border border-grid-bounds px-4 py-2 font-mono text-xs text-zinc-300 disabled:opacity-50"
            >
              use code
            </button>
          </>
        ) : (
          <>
            <h1 className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-400">
              pair this device
            </h1>
            <p className="mt-2 font-mono text-xs leading-relaxed text-zinc-500">
              open an invite link from kern → settings → web remote people, or
              paste the code:
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void connect();
              }}
              placeholder="invite code"
              autoCapitalize="characters"
              className="mt-4 w-full border border-grid-bounds bg-bg-core px-3 py-2 font-mono text-xs uppercase tracking-widest text-zinc-100"
            />
            <button
              onClick={() => void connect()}
              disabled={busy || !code.trim()}
              className="mt-3 w-full bg-signal-high px-4 py-2 font-mono text-xs font-semibold text-bg-core disabled:opacity-50"
            >
              {busy ? "pairing…" : "connect"}
            </button>
          </>
        )}

        {error && <p className="mt-3 font-mono text-xs text-fault-vector">{error}</p>}
      </div>
    </div>
  );
}
