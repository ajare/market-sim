/**
 * Random external events: market-wide demand/supply shocks (MarketEvent),
 * per-transport shocks (TransportEvent), whole-Company cash shocks
 * (CompanyEvent), and whole-port shutdowns (LocationClosure). Ported from
 * sim/events.py.
 */
import type { EventTemplate } from "./commodity";

export abstract class Event {
  type = "";
  scope = "";
  subject = "";
  message = "";
  duration = 1;
  day: number | null = null;
  daysRemaining = 0;

  /** Advance the event by one day. Returns true if still active. */
  tick(): boolean {
    this.daysRemaining -= 1;
    return this.daysRemaining > 0;
  }

  toString(): string {
    const dayStr = this.day !== null ? `day ${this.day}, ` : "";
    return `[${this.type}] ${this.scope}: ${this.message} (${dayStr}${this.daysRemaining}/${this.duration}d remaining)`;
  }
}

export interface MarketEventInit {
  name: string;
  demandMultiplier?: number;
  supplyMultiplier?: number;
  durationDays?: number;
  location?: string | null;
  commodity?: string | null;
}

/**
 * A random external shock that temporarily modifies demand/supply for a
 * commodity. If `location` is set the event is LOCAL (one location's
 * market); otherwise it's GLOBAL (every location trading the commodity) or
 * WORLDWIDE (every market) -- World disambiguates and stamps the real
 * `type` after construction (see world.ts).
 */
export class MarketEvent extends Event {
  name: string;
  demandMultiplier: number;
  supplyMultiplier: number;
  durationDays: number;
  location: string | null;
  commodity: string | null;

  constructor(init: MarketEventInit) {
    super();
    this.name = init.name;
    this.demandMultiplier = init.demandMultiplier ?? 1.0;
    this.supplyMultiplier = init.supplyMultiplier ?? 1.0;
    this.durationDays = init.durationDays ?? 1;
    this.location = init.location ?? null;
    this.commodity = init.commodity ?? null;

    this.daysRemaining = this.durationDays;
    this.message = this.name;
    this.duration = this.durationDays;
    this.scope = this.location ? this.location : "Global";
    this.type = this.location ? "Local" : "Global";
    this.subject = this.commodity ?? "";
  }
}

export type TransportEventKind =
  | "delay"
  | "cargo_loss"
  | "cash_gain"
  | "cash_loss"
  | "fuel_discount"
  | "fixed_cost_discount";

export interface TransportEventInit {
  name: string;
  kind: TransportEventKind;
  magnitude: number;
  durationDays?: number;
  startedDay?: number | null;
}

/**
 * A random shock that hits a specific Transport rather than a market --
 * doesn't move prices, changes what the transport itself can do. See
 * AGENT_EVENT_TEMPLATES below for what each `kind` does.
 */
export class TransportEvent extends Event {
  name: string;
  kind: TransportEventKind;
  magnitude: number;
  durationDays: number;
  startedDay: number | null;

  constructor(init: TransportEventInit) {
    super();
    this.name = init.name;
    this.kind = init.kind;
    this.magnitude = init.magnitude;
    this.durationDays = init.durationDays ?? 1;
    this.startedDay = init.startedDay ?? null;

    this.daysRemaining = this.durationDays;
    this.message = this.name;
    this.duration = this.durationDays;
    this.day = this.startedDay;
    this.type = "Agent";
    this.scope = "Transport";
  }
}

export interface AgentEventTemplate {
  name: string;
  kind: TransportEventKind;
  magnitude: number;
  durationDays: number;
}

export const AGENT_EVENT_TEMPLATES: AgentEventTemplate[] = [
  { name: "Engine trouble slows the transport", kind: "delay", magnitude: 2, durationDays: 1 },
  { name: "Customs hold at the dock", kind: "delay", magnitude: 1, durationDays: 1 },
  { name: "Cargo spoilage in transit", kind: "cargo_loss", magnitude: 0.15, durationDays: 1 },
  { name: "Piracy incident", kind: "cargo_loss", magnitude: 0.4, durationDays: 1 },
  { name: "Insurance payout received", kind: "cash_gain", magnitude: 400.0, durationDays: 1 },
  { name: "Unexpected repair bill", kind: "cash_loss", magnitude: 250.0, durationDays: 1 },
  { name: "Favorable tailwinds improve fuel efficiency", kind: "fuel_discount", magnitude: 0.25, durationDays: 6 },
  { name: "Preferred customer rate at the port", kind: "fixed_cost_discount", magnitude: 0.5, durationDays: 8 },
];

export type CompanyEventKind = "cash_gain" | "cash_loss";

export interface CompanyEventInit {
  name: string;
  kind: CompanyEventKind;
  magnitude: number;
  durationDays?: number;
}

/**
 * A random shock that hits a whole Company's shared cash pool directly --
 * only ever rolled for a plain Company, never a SoloTrader/PirateBrigade/
 * PoliceFleet.
 */
export class CompanyEvent extends Event {
  name: string;
  kind: CompanyEventKind;
  magnitude: number;
  durationDays: number;

  constructor(init: CompanyEventInit) {
    super();
    this.name = init.name;
    this.kind = init.kind;
    this.magnitude = init.magnitude;
    this.durationDays = init.durationDays ?? 1;

    this.daysRemaining = this.durationDays;
    this.message = this.name;
    this.duration = this.durationDays;
    this.type = "Company";
    this.scope = "Company";
  }
}

export interface CompanyEventTemplate {
  name: string;
  kind: CompanyEventKind;
  magnitude: number;
  durationDays: number;
}

export const COMPANY_EVENT_TEMPLATES: CompanyEventTemplate[] = [
  { name: "Insurance settlement received", kind: "cash_gain", magnitude: 5000.0, durationDays: 1 },
  { name: "Favorable trade financing arranged", kind: "cash_gain", magnitude: 2500.0, durationDays: 1 },
  { name: "Government subsidy for fleet modernization", kind: "cash_gain", magnitude: 6000.0, durationDays: 1 },
  { name: "Regulatory fine for safety violations", kind: "cash_loss", magnitude: 3000.0, durationDays: 1 },
  { name: "Corporate tax audit settlement", kind: "cash_loss", magnitude: 4000.0, durationDays: 1 },
  { name: "Embezzlement scandal costs the company", kind: "cash_loss", magnitude: 5500.0, durationDays: 1 },
];

// Commodity-agnostic shocks: LOCATION-WIDE hits every commodity's market at
// one location; WORLDWIDE hits every market in the entire simulation.
export const LOCATION_EVENT_TEMPLATES: EventTemplate[] = [
  { name: "Port strike halts local trade", demandMultiplier: 1.0, supplyMultiplier: 0.5, durationDays: 5 },
  { name: "Regional economic boom", demandMultiplier: 1.3, supplyMultiplier: 1.0, durationDays: 5 },
  { name: "Local political instability", demandMultiplier: 0.85, supplyMultiplier: 0.85, durationDays: 6 },
  { name: "Infrastructure upgrade boosts throughput", demandMultiplier: 1.0, supplyMultiplier: 1.25, durationDays: 5 },
  { name: "Regional tax holiday spurs local demand", demandMultiplier: 1.2, supplyMultiplier: 1.0, durationDays: 4 },
];

export const WORLD_EVENT_TEMPLATES: EventTemplate[] = [
  { name: "Global recession dampens demand everywhere", demandMultiplier: 0.85, supplyMultiplier: 1.0, durationDays: 7 },
  { name: "Worldwide economic boom lifts demand", demandMultiplier: 1.2, supplyMultiplier: 1.0, durationDays: 6 },
  { name: "Global shipping crisis squeezes supply chains", demandMultiplier: 1.0, supplyMultiplier: 0.8, durationDays: 6 },
  { name: "Landmark global trade agreement", demandMultiplier: 1.1, supplyMultiplier: 1.1, durationDays: 5 },
  { name: "Worldwide interest rate hike cools demand", demandMultiplier: 0.9, supplyMultiplier: 1.0, durationDays: 6 },
];

export interface LocationClosureInit {
  name: string;
  durationDays?: number;
}

/**
 * A binary shock: while active, a location's port is simply CLOSED -- no
 * buying, selling, or refueling there at all, for anyone, until it reopens.
 */
export class LocationClosure extends Event {
  name: string;
  durationDays: number;

  constructor(init: LocationClosureInit) {
    super();
    this.name = init.name;
    this.durationDays = init.durationDays ?? 1;

    this.daysRemaining = this.durationDays;
    this.message = this.name;
    this.duration = this.durationDays;
    this.type = "Closure";
  }
}

export interface LocationClosureTemplate {
  name: string;
  durationDays: number;
}

export const LOCATION_CLOSURE_TEMPLATES: LocationClosureTemplate[] = [
  { name: "Quarantine shuts the port to all shipping", durationDays: 6 },
  { name: "War disrupts port operations", durationDays: 10 },
  { name: "Naval blockade seals the harbor", durationDays: 8 },
  { name: "Labor strike halts all port activity", durationDays: 4 },
  { name: "Catastrophic storm damage closes the port", durationDays: 5 },
];
