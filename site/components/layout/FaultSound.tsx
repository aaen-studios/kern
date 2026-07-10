"use client";

import { useEffect } from "react";
import { useSound } from "@/hooks/useSound";

/*
  Tiny client island that plays the fault voice once on mount. Lets the
  server-rendered not-found page keep its SSR benefits while still firing the
  in-world fault sound.
*/
export function FaultSound() {
  const { play } = useSound();
  useEffect(() => {
    play("fault");
  }, [play]);
  return null;
}
