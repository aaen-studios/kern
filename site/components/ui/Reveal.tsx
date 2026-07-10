"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

/*
  Staggered section reveal. Skipped entirely under prefers-reduced-motion
  (renders children statically). Used across landing sections (§10).
*/
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.4, delay, ease: "easeOut" }}
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
      <p className="font-mono text-xs lowercase text-signal-low">
        {"// "}
        {kicker}
      </p>
      <h2 className="mt-2 font-mono text-2xl font-medium lowercase text-zinc-100 sm:text-3xl">
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
