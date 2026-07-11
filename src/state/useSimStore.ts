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
import type { PoliticalEntity } from "../sim/politicalEntity";
import { Company, type ContractStrategy, type Faction } from "../sim/faction";

interface SimStore {
  world: World | null;
  factions: Faction[];
  politicalEntities: PoliticalEntity[];
  day: number;
  playing: boolean;
  secondsPerDay: number;
  contractStrategy: ContractStrategy;
  version: number;
  reset: () => void;
  step: () => void;
  tick: (deltaTimeSeconds: number) => void;
  setPlaying: (playing: boolean) => void;
  setSecondsPerDay: (secondsPerDay: number) => void;
  setContractStrategy: (contractStrategy: ContractStrategy) => void;
  addPirateShip: () => void;
  removePirateShip: () => void;
  addPoliceShip: () => void;
  removePoliceShip: () => void;
}

let accumulator = 0;

/** Push a strategy onto every Company in a fleet -- read live by Company.directFleet, so this takes effect on the next simulated day. */
function applyContractStrategy(factions: Faction[], strategy: ContractStrategy): void {
  for (const faction of factions) {
    if (faction instanceof Company) faction.contractStrategy = strategy;
  }
}

export const useSimStore = create<SimStore>((set, get) => ({
  world: null,
  factions: [],
  politicalEntities: [],
  day: 0,
  playing: false,
  secondsPerDay: 1.0,
  contractStrategy: "compare",
  version: 0,

  reset: () => {
    const { world, factions, politicalEntities } = buildWorld(3000, { autoMinStockpileDaysFromRoutes: true });
    applyContractStrategy(factions, get().contractStrategy);
    accumulator = 0;
    set((s) => ({ world, factions, politicalEntities, day: 0, playing: false, version: s.version + 1 }));
  },

  step: () => {
    const { world } = get();
    if (world === null) return;
    const day = world.step();
    set((s) => ({ day, version: s.version + 1 }));
  },

  tick: (deltaTimeSeconds: number) => {
    const { playing, secondsPerDay, step } = get();
    if (!playing) return;
    accumulator += deltaTimeSeconds;
    while (accumulator >= secondsPerDay) {
      step();
      accumulator -= secondsPerDay;
    }
  },

  setPlaying: (playing: boolean) => set({ playing }),
  setSecondsPerDay: (secondsPerDay: number) => set({ secondsPerDay }),
  setContractStrategy: (contractStrategy: ContractStrategy) => {
    applyContractStrategy(get().factions, contractStrategy);
    set((s) => ({ contractStrategy, version: s.version + 1 }));
  },

  addPirateShip: () => {
    const { world } = get();
    if (world === null) return;
    world.addPirateShip();
    set((s) => ({ version: s.version + 1 }));
  },
  removePirateShip: () => {
    const { world } = get();
    if (world === null) return;
    world.removePirateShip();
    set((s) => ({ version: s.version + 1 }));
  },
  addPoliceShip: () => {
    const { world } = get();
    if (world === null) return;
    world.addPoliceShip();
    set((s) => ({ version: s.version + 1 }));
  },
  removePoliceShip: () => {
    const { world } = get();
    if (world === null) return;
    world.removePoliceShip();
    set((s) => ({ version: s.version + 1 }));
  },
}));

// Build the initial world immediately, mirroring SimState.__init__ calling reset().
useSimStore.getState().reset();
