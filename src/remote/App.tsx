import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { consumeLegacyToken, getToken } from "./lib/session";
import { navigate, useSegments } from "./lib/router";
import { ServersProvider, useServers } from "./lib/servers";
import { useSse, type SseStatus } from "./lib/sse";
import type { AuthUser } from "./lib/types";
import { Shell } from "./components/Shell";
import { Gate } from "./pages/Gate";
import { Overview } from "./pages/Overview";
import { ServerView } from "./pages/ServerView";
import { Audit } from "./pages/Audit";
import { Settings } from "./pages/Settings";

type Phase = "checking" | "gate" | "ready";

export function App() {
  const segments = useSegments();
  const [phase, setPhase] = useState<Phase>("checking");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [invite, setInvite] = useState<string | null>(null);

  useEffect(() => {
    consumeLegacyToken();
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const code = hash.get("invite");
    if (code) {
      setInvite(code);
      setPhase("gate");
      return;
    }
    if (!getToken()) {
      setPhase("gate");
      return;
    }
    api<{ user: AuthUser }>("/remote/session")
      .then((data) => {
        setUser(data.user);
        setPhase("ready");
      })
      .catch(() => setPhase("gate"));
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null);
      setPhase("gate");
    };
    window.addEventListener("kern:unauthorized", onUnauthorized);
    return () => window.removeEventListener("kern:unauthorized", onUnauthorized);
  }, []);

  if (phase === "checking") {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="font-mono text-xs text-zinc-500">connecting…</span>
      </div>
    );
  }

  if (phase === "gate" || !user) {
    return (
      <Gate
        invite={invite}
        onPaired={(paired) => {
          setUser(paired);
          setPhase("ready");
          navigate("/overview");
        }}
      />
    );
  }

  return (
    <ServersProvider enabled>
      <Ready user={user} segments={segments} />
    </ServersProvider>
  );
}

function Ready({ user, segments }: { user: AuthUser; segments: string[] }) {
  const { patchStatuses } = useServers();
  const [conn, setConn] = useState<SseStatus>("connecting");

  const status = useSse("/events", (event, data) => {
    if (event === "statuses") {
      const payload = data as { servers?: { id: string; status?: string | null; running: boolean }[] };
      if (payload.servers) patchStatuses(payload.servers);
    }
  });
  useEffect(() => setConn(status), [status]);

  const [section, id, tab] = segments;
  const page =
    section === "s" && id ? (
      <ServerView id={id} tab={tab ?? "console"} user={user} />
    ) : section === "audit" ? (
      <Audit />
    ) : section === "settings" ? (
      <Settings user={user} />
    ) : (
      <Overview user={user} />
    );

  return (
    <Shell user={user} section={section ?? "overview"} conn={conn}>
      {page}
    </Shell>
  );
}
