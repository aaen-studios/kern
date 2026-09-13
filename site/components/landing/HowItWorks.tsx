import { Section } from "@/components/ui/Section";
import { Panel } from "@/components/ui/Panel";
import { SectionHeading, Reveal } from "@/components/ui/Reveal";
import { StatusDots } from "@/components/ui/StatusDots";

/*
  How it works — register → plugin → start, three beats with small mocks.
  No screenshots, no video: the mock vocabulary (paths, manifests, status
  rows) is the same one the terminal and lifecycle sections use.
*/

function RegisterMock() {
  return (
    <Panel className="p-4">
      <p className="font-mono text-[10px] lowercase text-signal-low">
        path
      </p>
      <div className="mt-1 bg-bg-surface px-2.5 py-2 font-mono text-[11px] text-zinc-200">
        ~/srv/paper-server
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="bg-bg-surface px-2 py-0.5 font-mono text-[10px] lowercase text-signal-low ring-1 ring-grid-bounds">
          minecraft
        </span>
        <span className="bg-bg-surface px-2 py-0.5 font-mono text-[10px] lowercase text-signal-low ring-1 ring-grid-bounds">
          prod
        </span>
      </div>
      <div className="mt-3 bg-signal-high/10 px-2 py-1.5 text-center font-mono text-[10px] lowercase text-signal-high ring-1 ring-signal-high/30">
        register instance
      </div>
    </Panel>
  );
}

function PluginMock() {
  return (
    <Panel className="p-4">
      <p className="font-mono text-[10px] lowercase text-signal-low">
        paper.kern
      </p>
      <div className="mt-2 space-y-1 bg-bg-surface px-2.5 py-2 font-mono text-[10px] leading-relaxed text-zinc-300">
        <p>
          <span className="text-signal-low">id:</span> minecraft_java
        </p>
        <p>
          <span className="text-signal-low">shape:</span> 7 softwares
        </p>
        <p>
          <span className="text-signal-low">stop:</span> stdin “stop”
        </p>
        <p>
          <span className="text-signal-low">tabs:</span> setup · chat · manage
        </p>
      </div>
      <p className="mt-3 font-mono text-[10px] lowercase text-signal-high">
        ✓ checksum verified · permissions reviewed
      </p>
    </Panel>
  );
}

function StartMock() {
  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between">
        <StatusDots status="wave" label="running" count={4} />
        <span className="font-mono text-[10px] lowercase text-signal-low">
          pid 3821 · :25565
        </span>
      </div>
      <div className="mt-3 space-y-1 bg-bg-surface px-2.5 py-2 font-mono text-[10px] leading-relaxed">
        <p className="text-zinc-300">[12:04:28] Preparing spawn area: 96%</p>
        <p className="text-signal-high">
          [12:04:31] Done (3.2s)! For help, type “help”
        </p>
      </div>
      <p className="mt-3 font-mono text-[10px] lowercase text-signal-low">
        graceful stop in the bar · force-kill after timeout
      </p>
    </Panel>
  );
}

const STEPS = [
  {
    n: "01",
    title: "register a folder",
    body: "point kern at any directory. it becomes an instance — crud, orphan detection, per-instance settings.",
    mock: <RegisterMock />,
  },
  {
    n: "02",
    title: "install a plugin",
    body: "a .kern package declares how the server installs, starts, and stops. seven minecraft softwares or four bot runtimes — your pick.",
    mock: <PluginMock />,
  },
  {
    n: "03",
    title: "press start",
    body: "live terminal, per-process telemetry, graceful shutdown, crash watchdog. then script it with kern-cli.",
    mock: <StartMock />,
  },
];

export function HowItWorks() {
  return (
    <Section band size="default">
      <Reveal>
        <SectionHeading kicker="how it works" title="any folder. three moves.">
          no docker files, no daemon install, no yaml. kern is a desktop app
          that turns a directory into a managed server.
        </SectionHeading>
      </Reveal>

      <div className="grid gap-4 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <Reveal key={step.n} delay={0.08 * (i + 1)}>
            <div className="flex h-full flex-col gap-4">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-xs text-signal-high">
                  {step.n}
                </span>
                <h3 className="font-mono text-h3 lowercase text-zinc-100">
                  {step.title}
                </h3>
              </div>
              <p className="font-mono text-xs leading-relaxed text-signal-low">
                {step.body}
              </p>
              <div className="mt-auto">{step.mock}</div>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
