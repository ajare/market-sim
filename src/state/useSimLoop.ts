/** Drives useSimStore.tick(dt) off requestAnimationFrame -- replicates SimState.tick's seconds-per-day accumulator. */
import { useEffect, useRef } from "react";
import { useSimStore } from "./useSimStore";

export function useSimLoop(): void {
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  useEffect(() => {
    function frame(time: number): void {
      if (lastTimeRef.current !== null) {
        const deltaTimeSeconds = (time - lastTimeRef.current) / 1000;
        useSimStore.getState().tick(deltaTimeSeconds);
      }
      lastTimeRef.current = time;
      rafRef.current = requestAnimationFrame(frame);
    }
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);
}
