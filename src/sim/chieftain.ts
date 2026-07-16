/**
 * Chieftain: a village's personal ruler -- extends Person directly (not
 * Sailor) since a chieftain never crews a Transport, so Sailor's wage/rank/
 * piracy fields don't apply. When set as a Location's `ruler` (see
 * location.ts), a chieftain's own authority takes precedence over the
 * Location's owning PoliticalEntity for diplomacy decisions (see
 * decisions.ts's buildPassageTaxDecision, which reads
 * `location.ruler ?? location.politicalEntity`).
 */
import { Person, type PersonInit } from "./person";

export interface ChieftainInit extends PersonInit {
  /** Fraction of the party's cash/value demanded as passage tax on arrival. Defaults to 0.1 (10%). */
  passageTaxRate?: number;
  /** [0, 1] -- persistent trust toward the player's party, shifted by the outcome of each passage-tax negotiation. Defaults to 0.5 (neutral). */
  trust?: number;
  /** Commodity ids this chieftain will accept as a gift/tribute in place of cash. */
  giftCategories?: string[];
}

export class Chieftain extends Person {
  passageTaxRate: number;
  trust: number;
  giftCategories: string[];

  constructor(init: ChieftainInit) {
    super(init);
    this.passageTaxRate = init.passageTaxRate ?? 0.1;
    this.trust = init.trust ?? 0.5;
    this.giftCategories = init.giftCategories ?? [];
  }
}
