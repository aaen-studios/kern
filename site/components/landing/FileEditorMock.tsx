import { SectionHeading, Reveal } from "@/components/ui/Reveal";

/*
  §10.7 — File editor. Monaco-style mock with a file tree, tabbed multi-file
  editing, path-traversal protection, and drag-and-drop copy from the os.
*/

const TREE: Array<{ name: string; depth: number; kind: "dir" | "file" | "active" }> = [
  { name: "minecraft_java", depth: 0, kind: "dir" },
  { name: "paper-1.21.jar", depth: 1, kind: "file" },
  { name: "server.properties", depth: 1, kind: "active" },
  { name: "eula.txt", depth: 1, kind: "file" },
  { name: "world", depth: 1, kind: "dir" },
  { name: "level.dat", depth: 2, kind: "file" },
  { name: "ops.json", depth: 1, kind: "file" },
];

const SAMPLE = `#Minecraft server properties
server-port=25565
max-players=20
motd=kern-managed instance
level-name=world
enable-command-block=true
view-distance=10`;

export function FileEditorMock() {
  return (
    <section className="border-y border-grid-bounds/40 bg-bg-surface/30">
      <div className="mx-auto max-w-[1080px] px-4 py-24 sm:px-6">
        <Reveal>
          <SectionHeading kicker="file editor" title="edit in place. safe paths.">
            monaco editor with a file tree, tabbed multi-file editing,
            path-traversal protection, and drag-and-drop copy from the os.
          </SectionHeading>
        </Reveal>

        <Reveal delay={0.1}>
          <div
            className="grid grid-cols-1 overflow-hidden bg-bg-core md:grid-cols-[200px_1fr]"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            {/* file tree */}
            <div className="border-r border-grid-bounds/50 p-3">
              <p className="mb-2 font-mono text-[11px] lowercase text-signal-low">
                explorer
              </p>
              <ul className="space-y-0.5">
                {TREE.map((n, i) => (
                  <li
                    key={i}
                    className={`flex items-center gap-1.5 font-mono text-[11px] ${
                      n.kind === "active"
                        ? "text-signal-high"
                        : n.kind === "dir"
                          ? "text-zinc-300"
                          : "text-signal-low"
                    }`}
                    style={{ paddingLeft: `${n.depth * 12}px` }}
                  >
                    <span aria-hidden="true">
                      {n.kind === "dir" ? "▸" : "·"}
                    </span>
                    <span>{n.name}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* editor pane */}
            <div>
              <div className="flex items-center gap-2 border-b border-grid-bounds/50 px-3 py-2">
                <span className="bg-bg-surface px-2 py-1 font-mono text-[11px] text-signal-high ring-1 ring-grid-bounds">
                  server.properties
                </span>
                <span className="px-2 py-1 font-mono text-[11px] text-signal-low">
                  + eula.txt
                </span>
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-zinc-300">
                <code>{SAMPLE}</code>
              </pre>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
