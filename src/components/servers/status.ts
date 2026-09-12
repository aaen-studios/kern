import type { DotColor } from "../../types/matrix";
import type { ServerInstance, ServerStatus } from "../../types/server";

/**
 * Maps a server's runtime + orphaned state onto the emission-matrix color axis
 * (DesignGuide §2). Orphaned always wins so a dead path can't be hidden behind
 * a stale "running" status.
 */
export function statusColor(server: ServerInstance): DotColor {
  if (server.isOrphaned) return "crimson";
  if (server.status === "error") return "amber";
  switch (server.status as ServerStatus) {
    case "running":
      return "green";
    case "starting":
    case "stopping":
    case "installing":
    case "stopped-forced":
      return "amber";
    case "stopped":
    default:
      return "gray";
  }
}

/** Hex value for a status color, mirroring MatrixViewport's palette map. */
export function statusHex(color: DotColor): string {
  switch (color) {
    case "green":
      return "#4cf5a0";
    case "amber":
      return "#f5a04c";
    case "crimson":
      return "#f54c4c";
    case "gray":
    default:
      return "#4c525e";
  }
}
