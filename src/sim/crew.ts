/**
 * Crew: base class for anyone who operates a Transport. Ported from
 * sim/crew.py.
 */
import type { Transport } from "./transport";

export class Crew {
  name: string;
  transport: Transport | null;
  /**
   * Per-day wage rate for this Crew member, used to size the lump-sum
   * payment a Captain pays upfront at departure -- dailyWages * the trip's
   * estimated day count (see captain.ts's dailyCrewCost/routeEconomics).
   * Idle time in port costs nothing regardless of rate.
   */
  dailyWages: number;

  constructor(name: string, transport: Transport | null = null, dailyWages: number = 0.0) {
    this.name = name;
    this.transport = transport;
    this.dailyWages = dailyWages;
  }
}

/**
 * A generic deckhand: fills out a Transport's crewRequirement beyond its
 * Captain, who is itself a Crew member and costs nothing extra by default.
 */
export class Sailor extends Crew {
  constructor(name: string, transport: Transport | null = null, dailyWages: number = 20.0) {
    super(name, transport, dailyWages);
  }
}
