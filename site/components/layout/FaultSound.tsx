"use client";

import { useEffect, useRef } from "react";
import { useSound } from "@/hooks/useSound";

/*
  Tiny client island that plays the fault voice once on mount. Lets the
  server-rendered not-found page keep its SSR benefits while still firing the
  in-world fault sound. Uses a ref so the effect runs exactly once without
  depending on the (changing) `play` identity.
*/
export function FaultSound() {
  const { play } = useSound();
  const playRef = useRef(play);
  useEffect(() => {
    playRef.current = play;
  });
  useEffect(() => {
    playRef.current("fault");
  }, []);
  return null;
}
