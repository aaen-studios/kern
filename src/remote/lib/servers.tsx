/** Shared server list: fetched once, patched by the events stream. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import type { ServerSummary } from "./types";

interface ServersApi {
  servers: ServerSummary[];
  loading: boolean;
  refresh: () => Promise<void>;
  patchStatuses: (list: { id: string; status?: string | null; running: boolean }[]) => void;
}

const ServersContext = createContext<ServersApi>({
  servers: [],
  loading: true,
  refresh: async () => {},
  patchStatuses: () => {},
});

export function useServers(): ServersApi {
  return useContext(ServersContext);
}

export function ServersProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await api<{ servers: ServerSummary[] }>("/servers");
      setServers(data.servers ?? []);
    } catch {
      /* transient; the next poll retries */
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  const patchStatuses = useCallback(
    (list: { id: string; status?: string | null; running: boolean }[]) => {
      setServers((prev) => {
        let changed = false;
        const next = prev.map((server) => {
          const patch = list.find((entry) => entry.id === server.id);
          if (!patch) return server;
          if (server.running !== patch.running || server.status !== (patch.status ?? server.status)) {
            changed = true;
            return {
              ...server,
              running: patch.running,
              status: patch.status ?? server.status,
            };
          }
          return server;
        });
        return changed ? next : prev;
      });
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    timer.current = window.setInterval(() => void refresh(), 10000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [enabled, refresh]);

  return (
    <ServersContext.Provider value={{ servers, loading, refresh, patchStatuses }}>
      {children}
    </ServersContext.Provider>
  );
}
