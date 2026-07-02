"use client";

import { useEffect, useState } from "react";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useMotionValueEvent,
} from "motion/react";
import { useReducedMotion } from "motion/react";

/*
  Animated counter that ticks up from 0 to `value` on mount.
  Uses a spring physics animation for a satisfying deceleration curve.
  Respects prefers-reduced-motion → renders the final value instantly.
*/
export function Odometer({
  value,
  prefix = "",
  className = "",
}: {
  value: number;
  prefix?: string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const motionValue = useMotionValue(reduce ? value : 0);
  const spring = useSpring(motionValue, { stiffness: 60, damping: 15 });
  const fmt = new Intl.NumberFormat("en-US");
  const display = useTransform(spring, (v) => fmt.format(Math.floor(v)));
  const [text, setText] = useState(fmt.format(value));

  useMotionValueEvent(display, "change", setText);

  useEffect(() => {
    motionValue.set(value);
  }, [value, motionValue]);

  return (
    <motion.span className={className}>
      {prefix}
      {text}
    </motion.span>
  );
}
