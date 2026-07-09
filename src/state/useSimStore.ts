/**
 * Wraps a live World + its Factions with play/pause/step controls --
 * mirrors sim/state.py's SimState, as a Zustand store so React components
 * can subscribe to it.
 *
 * World/Captain/Location mutate in place (the engine port keeps Python's
 * mutation model, not a rewrite to immutable updates), so this store also
 * tracks a bare `version` counter bumped on every step -- components
 * subscribe to `version` to know when to re-render, then read live fields
 * straight off `world`/`captain` objects, the same way an ImGui panel reads
 * live struct fields every frame.
 */
import { create } from "zustand";
import { buildWorld } from "../sim/buildWorld";
import type { World } from "../sim/world";
import type { Faction } from "../sim/faction";

interface SimStore {
  world: World | null;
  factions: Faction[];
  day: number;
  playing: boolean;
  daysPerSecond: number;
  version: number;
  reset: () => void;
  step: () => void;
  tick: (deltaTimeSeconds: number) => void;
  setPlaying: (playing: boolean) => void;
  setDaysPerSecond: (daysPerSecond: number) => void;
}

let accumulator = 0;

export const useSimStore = create<SimStore>((set, get) => ({
  world: null,
  factions: [],
  day: 0,
  playing: false,
  daysPerSecond: 1.0,
  version: 0,

  reset: () => {
    const { world, factions } = buildWorld(1000);
    accumulator = 0;
    set((s) => ({ world, factions, day: 0, playing: false, version: s.version + 1 }));
  },

  step: () => {
    const { world } = get();
    if (world === null) return;
    const day = world.step();
    set((s) => ({ day, version: s.version + 1 }));
  },

  tick: (deltaTimeSeconds: number) => {
    const { playing, daysPerSecond, step } = get();
    if (!playing) return;
    accumulator += deltaTimeSeconds * daysPerSecond;
    while (accumulator >= 1.0) {
      step();
      accumulator -= 1.0;
    }
  },

  setPlaying: (playing: boolean) => set({ playing }),
  setDaysPerSecond: (daysPerSecond: number) => set({ daysPerSecond }),
}));

// Build the initial world immediately, mirroring SimState.__init__ calling reset().
useSimStore.getState().reset();
