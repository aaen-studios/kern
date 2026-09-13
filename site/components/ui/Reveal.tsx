"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { Kicker } from "@/components/ui/Kicker";

/*
  Staggered section reveal. Skipped entirely under prefers-reduced-motion
  (renders children statically). Used across landing sections (§10).

  direction sets the entry offset; the default matches the original motion.
*/
const OFFSETS = {
  up: { y: 12 },
  left: { x: 16 },
  right: { x: -16 },
  none: {},
} as const;

export function Reveal({
  children,
  delay = 0,
  direction = "up",
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  direction?: keyof typeof OFFSETS;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, ...OFFSETS[direction] }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.4, delay, ease: [0.25, 1, 0.5, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function SectionHeading({
  kicker,
  title,
  children,
}: {
  kicker: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-10">
      <Kicker>{kicker}</Kicker>
      <h2 className="mt-2 font-mono text-h2 font-medium lowercase text-zinc-100">
        {title}
      </h2>
      {children && (
        <p className="mt-3 max-w-xl font-mono text-xs text-signal-low">
          {children}
        </p>
      )}
    </div>
  );
}
