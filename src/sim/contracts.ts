/**
 * Contract: a one-shot supply order -- "deliver `quantity` of `commodity`,
 * once." A `ContractIssuer` (see `location.ts`'s `Location`) posts one to a
 * `BulletinBoard`; a `ContractFulfiller` (see `faction.ts`'s `Company`) reads
 * the board, filtered to the `ContractType`s it can handle, and accepting a
 * posting removes it from the board immediately -- a posting is therefore
 * never both "on the board" and "claimed" at once. A Location-issued
 * Contract's goods are paid for directly out of the issuing Location's own
 * cash pool (at the producer's price), and its fuel cost is reimbursed plus
 * a fixed delivery fee on arrival -- the fulfiller never fronts the cost of
 * the goods themselves, only fuel. One open posting exists at a time per
 * (Location, consumed commodity) pair, tendered proactively once that pair's
 * stockpile drops to or below `contractThresholdFraction` times its minimum
 * target (see `Location.needsContractRestock`) and the Location isn't broke;
 * see `Location.tenderContracts`. An unclaimed posting expires
 * (`BulletinBoard.prune`) if it's not picked up in time, or is
 * force-replaced immediately if the shortage becomes severe first.
 */
import type { Location } from "./location";
import type { ContractFulfiller } from "./faction";
import type { Captain } from "./captain";

/** The kinds of Contract a ContractFulfiller can declare it handles (see ContractFulfiller.contractTypes). Only "Commodity" exists today -- a Location-issued supply order. */
export type ContractType = "Commodity";

// Tunable knobs for the contract system -- all named here (rather than left
// as inline literals) so the economics can be retuned without hunting
// through Location.tenderContracts' body. See TenderContractsOptions for
// per-call overrides of the four that feed it.

/** Base delivery fee, as a fraction of goods value, before urgency scaling -- see Location.tenderContracts. */
export const CONTRACT_BASE_FEE_RATE = 0.05;

/** Exponent of the exponential urgency curve: feeMultiplier = CONTRACT_FEE_ESCALATION_BASE ** deficitRatio, so this is the value the fee multiplier climbs toward as deficitRatio approaches 1 (stockpile at zero). Not specified by the design; easy to retune. */
export const CONTRACT_FEE_ESCALATION_BASE = 10;

/** Multiplier applied to minStockpile when sizing a tendered Contract's order quantity. 1.5, alongside a 5-ships-per-location fleet, is the minimum-fleet-size combination found via seed-averaged sweeps (see analysis.ts) that keeps the stockpile-vs-minimum metric at or above 1.0 on average. */
export const CONTRACT_QUANTITY_MULTIPLIER = 1.5;

/** Default days an unclaimed Contract stays open before BulletinBoard.prune expires it. */
export const DEFAULT_CONTRACT_EXPIRY_DAYS = 7;

/** Default fraction of minStockpile at which an unclaimed Contract is force-replaced before its expiry (see BulletinBoard.prune). */
export const DEFAULT_SEVERE_DEFICIT_FRACTION = 0.5;

export interface Contract {
  location: string;
  commodity: string;
  type: ContractType;
  quantity: number;
  /** Fixed payment on top of the fuel reimbursement -- agreed once at contract creation (scaled by shortage urgency, see Location.tenderContracts), immune to later market-price swings. */
  deliveryFee: number;
  /** null until a ContractFulfiller accepts it (see ContractFulfiller.acceptContract); permanent once accepted (contracts are never re-negotiated or dropped, only fulfilled). */
  fulfiller: ContractFulfiller | null;
  /** The captain currently carrying cargo against this contract, if any -- prevents piling a second shipment onto an already-committed delivery. */
  inFlightCaptain: Captain | null;
  /** Set true once delivered. */
  fulfilled: boolean;
  /** Day this contract was tendered. */
  beginDay: number;
  /** Day an unclaimed contract expires and is removed by BulletinBoard.prune. */
  expiryDay: number;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Canonical key for a (location, commodity) pair -- mirrors markets.ts's marketKey. */
export function contractKey(location: string, commodity: string): string {
  return `${location}::${commodity}`;
}

export interface TenderContractsOptions {
  /** Days an unclaimed contract stays open before it expires. Defaults to DEFAULT_CONTRACT_EXPIRY_DAYS. */
  expiryDays?: number;
  /** Base delivery fee rate, before urgency scaling. Defaults to CONTRACT_BASE_FEE_RATE. */
  baseFeeRate?: number;
  /** Exponent of the urgency curve. Defaults to CONTRACT_FEE_ESCALATION_BASE. */
  feeEscalationBase?: number;
  /** Multiplier applied to minStockpile to size the order quantity. Defaults to CONTRACT_QUANTITY_MULTIPLIER. */
  quantityMultiplier?: number;
}

/**
 * A store for Contracts that haven't been accepted yet. A ContractIssuer
 * posts to it (`post`); a ContractFulfiller accepts from it, which removes
 * the posting immediately (`remove`) -- so a posting is never both "open"
 * and "accepted" at once, and `prune` never needs to consider a fulfilled or
 * claimed posting (neither state can exist here by construction).
 */
export class BulletinBoard {
  private postings: Contract[] = [];

  get open(): readonly Contract[] {
    return this.postings;
  }

  post(contract: Contract): void {
    this.postings.push(contract);
  }

  /** Remove a posting once accepted. A no-op if it's already gone (e.g. pruned the same day). */
  remove(contract: Contract): void {
    const index = this.postings.indexOf(contract);
    if (index !== -1) this.postings.splice(index, 1);
  }

  /**
   * Drop expired postings, and unclaimed postings whose Location has fallen
   * to `severeDeficitFraction` of its minimum stockpile (removed immediately
   * rather than waiting on expiry -- `Location.tenderContracts`, called
   * right after in World.runDay, replaces it with a fresh, more
   * urgently-priced offer the same pass). Unlike the old array-based
   * pruning, a posting here is never fulfilled or claimed (acceptance
   * removes it immediately), so only expiry/severe-deficit apply.
   */
  prune(locations: readonly Location[], day: number, severeDeficitFraction: number = DEFAULT_SEVERE_DEFICIT_FRACTION): void {
    const byName = new Map(locations.map((l) => [l.name, l]));
    this.postings = this.postings.filter((c) => {
      if (day > c.expiryDay) return false;
      const location = byName.get(c.location);
      const min = location?.minStockpiles[c.commodity] ?? 0;
      const stock = location?.stockpiles[c.commodity] ?? 0;
      return !(min > 0 && stock <= severeDeficitFraction * min);
    });
  }
}
