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
import { buildWorldFromJson } from "../sim/buildWorldFromJson";
import type { World } from "../sim/world";
import type { Location } from "../sim/location";
import type { PoliticalEntity } from "../sim/politicalEntity";
import { Company, type ContractStrategy, type Faction } from "../sim/faction";
import type { Transport } from "../sim/transport";
import type { Sailor } from "../sim/sailor";
import type { Captain } from "../sim/captain";
import type { Person } from "../sim/person";

interface SimStore {
  world: World | null;
  factions: Faction[];
  politicalEntities: PoliticalEntity[];
  day: number;
  /** The in-world calendar date as of `day` -- see World.currentDate. Null before the initial reset(). */
  date: Date | null;
  playing: boolean;
  secondsPerDay: number;
  contractStrategy: ContractStrategy;
  version: number;
  /** The Captain currently selected in the Fleet panel, highlighted in the Network view -- null when nothing's selected. Cleared whenever a new World is built/loaded, since the old fleet's Captain objects no longer apply. */
  selectedCaptain: Captain | null;
  /** Toggles selection: selecting the already-selected Captain again clears it. Pass null to explicitly clear. */
  selectTransport: (captain: Captain | null) => void;
  /** The Person currently shown in the Person panel (a Captain or a plain Sailor) -- null when nothing's selected. Cleared whenever a new World is built/loaded, since the old fleet's Person objects no longer apply. */
  selectedPerson: Person | null;
  /** Toggles selection: selecting the already-selected Person again clears it. Pass null to explicitly clear. */
  selectPerson: (person: Person | null) => void;
  reset: () => void;
  /** Builds a fresh World from an editor JSON export (see buildWorldFromJson) and installs it, replacing the current one. Throws if the JSON can't be turned into a valid World -- the caller surfaces the message. */
  loadWorldFromJson: (text: string) => void;
  step: () => void;
  tick: (deltaTimeSeconds: number) => void;
  setPlaying: (playing: boolean) => void;
  setSecondsPerDay: (secondsPerDay: number) => void;
  setContractStrategy: (contractStrategy: ContractStrategy) => void;
  addPirateShip: () => void;
  removePirateShip: () => void;
  addPoliceShip: () => void;
  removePoliceShip: () => void;
  /**
   * Manual "Buy Ship" panel action -- see World.buyShipForCompany. Throws
   * (propagated to the caller, which surfaces the message) if the Company
   * can't afford the class, the class/Location is invalid, or there's no
   * live World.
   */
  buyShip: (company: Company, locationName: string, shipClassName: string) => void;
  /**
   * Adds a brand-new Location at (x, y) (world-unit coordinates) affiliated
   * with `politicalEntity` -- see World.addLocation. Returns null (no-op) if
   * there is no live World.
   */
  addLocation: (
    x: number,
    y: number,
    politicalEntity: PoliticalEntity,
    detourDistance: number,
    maxDistance: number,
  ) => Location | null;
  /**
   * Removes `member` from `transport`'s crew -- the Transports panel's "kill
   * crew member" button, only enabled while the ship is InTransit (guarded
   * here too, not just by the UI's disabled attribute). The ship hires a
   * replacement for free next time it's docked at a Port (see
   * Captain.hireCrewIfPossible). No-op if the transport isn't InTransit.
   */
  killCrewMember: (transport: Transport, member: Sailor) => void;
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
  date: null,
  playing: false,
  secondsPerDay: 1.0,
  contractStrategy: "compare",
  version: 0,
  selectedCaptain: null,
  selectTransport: (captain) => set((s) => ({ selectedCaptain: s.selectedCaptain === captain ? null : captain })),
  selectedPerson: null,
  selectPerson: (person) => set((s) => ({ selectedPerson: s.selectedPerson === person ? null : person })),

  reset: () => {
    const { world, factions, politicalEntities } = buildWorld(3000, { autoMinStockpileDaysFromRoutes: true });
    applyContractStrategy(factions, get().contractStrategy);
    accumulator = 0;
    set((s) => ({
      world, factions, politicalEntities, day: 0, date: world.currentDate, playing: false,
      selectedCaptain: null, selectedPerson: null, version: s.version + 1,
    }));
  },

  loadWorldFromJson: (text: string) => {
    // buildWorldFromJson throws on any failure (bad JSON, empty world, or a
    // domain-constructor validation error) -- let it propagate to the caller,
    // which shows the message; leave the current world untouched on failure.
    const { world, factions, politicalEntities } = buildWorldFromJson(text);
    applyContractStrategy(factions, get().contractStrategy);
    accumulator = 0;
    set((s) => ({
      world, factions, politicalEntities, day: 0, date: world.currentDate, playing: false,
      selectedCaptain: null, selectedPerson: null, version: s.version + 1,
    }));
  },

  step: () => {
    const { world } = get();
    if (world === null) return;
    const day = world.step();
    set((s) => ({ day, date: world.currentDate, version: s.version + 1 }));
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

  buyShip: (company, locationName, shipClassName) => {
    const { world } = get();
    if (world === null) return;
    world.buyShipForCompany(company, locationName, shipClassName);
    set((s) => ({ version: s.version + 1 }));
  },

  addLocation: (x, y, politicalEntity, detourDistance, maxDistance) => {
    const { world } = get();
    if (world === null) return null;
    const location = world.addLocation(x, y, politicalEntity, detourDistance, maxDistance);
    set((s) => ({ version: s.version + 1 }));
    return location;
  },

  killCrewMember: (transport, member) => {
    if (transport.status !== "InTransit") return;
    transport.removeCrewMember(member);
    set((s) => ({ version: s.version + 1 }));
  },
}));

// Build the initial world immediately, mirroring SimState.__init__ calling reset().
useSimStore.getState().reset();
