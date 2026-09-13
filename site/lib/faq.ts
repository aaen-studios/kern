/* FAQ content — shared by the landing section and the FAQPage JSON-LD. */
export const FAQ_ITEMS: Array<{ q: string; a: string }> = [
  {
    q: "is it free?",
    a: "yes. kern is free and open source. no account, no cloud, no seat pricing — you run it on your own machine.",
  },
  {
    q: "does it phone home?",
    a: "no. the only outbound call is an update check against github releases. the automation api is loopback-only, and the web remote is opt-in.",
  },
  {
    q: "where does my data live?",
    a: "in the app data directory (settings, plugins) and your instance folders (logs, backups, worlds). nothing is uploaded anywhere.",
  },
  {
    q: "what can it run?",
    a: "any folder you register: web servers, discord bots, minecraft, local databases. plugins teach kern how each type starts, stops, and configures.",
  },
  {
    q: "why desktop instead of a web panel?",
    a: "the servers run on your machine, so the manager does too — native process control (job objects on windows, process groups on unix), real telemetry, and no remote host to rent.",
  },
  {
    q: "are plugins safe?",
    a: "plugins declare capabilities in their manifest and you consent at install, with checksum verification. that is a boundary, not a sandbox — install from authors you trust.",
  },
  {
    q: "what happens if a server crashes?",
    a: "the watchdog restarts it with exponential backoff and keeps a last-crash report (exit code + log tail). notifications go to the center, os toasts, or your webhook.",
  },
  {
    q: "can i control it from my phone?",
    a: "yes — the web remote pairs over qr on your lan (self-signed https), optionally exposed through a cloudflare quick tunnel. scripts get the loopback api and kern-cli.",
  },
  {
    q: "which platforms?",
    a: "windows, macos, and linux. builds are unsigned for now: windows smart screen needs “more info → run anyway”, macos may need right-click → open.",
  },
];
