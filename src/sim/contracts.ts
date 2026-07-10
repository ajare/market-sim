/**
 * Contract: a one-shot supply order tendered by a Location to whichever
 * Company claims it -- "deliver `quantity` of `commodity`, once." The
 * Location issuing the contract pays for the goods directly (at the
 * producer's price, straight out of the Location's own cash pool) and
 * reimburses the delivering Company's fuel cost plus a fixed delivery fee
 * on arrival -- the Company never fronts the cost of the goods themselves,
 * only fuel. One open Contract exists at a time per (Location, consumed
 * commodity) pair, tendered proactively once that pair's stockpile drops to
 * or below `contractThresholdFraction` times its minimum target (see
 * `Location.needsContractRestock`) and the Location isn't broke; see
 * `tenderContracts`. An unclaimed contract expires (`pruneContracts`) if
 * it's not picked up in time, or is force-replaced immediately if the
 * shortage becomes severe first. Only a `Company` (not a `SoloTrader`) will
 * claim one -- see `Faction.acceptsContracts` -- and `Company.directFleet`
 * prioritizes servicing claimed contracts over independent arbitrage.
 */
import type { Location } from "./location";
import type { Faction } from "./faction";
import type { Captain } from "./captain";

// Tunable knobs for the contract system -- all named here (rather than left
// as inline literals) so the economics can be retuned without hunting
// through tenderContracts' body. See TenderContractsOptions for per-call
// overrides of the four that feed tenderContracts.

/** Base delivery fee, as a fraction of goods value, before urgency scaling -- see tenderContracts. */
export const CONTRACT_BASE_FEE_RATE = 0.05;

/** Exponent of the exponential urgency curve: feeMultiplier = CONTRACT_FEE_ESCALATION_BASE ** deficitRatio, so this is the value the fee multiplier climbs toward as deficitRatio approaches 1 (stockpile at zero). Not specified by the design; easy to retune. */
export const CONTRACT_FEE_ESCALATION_BASE = 10;

/** Multiplier applied to minStockpile when sizing a tendered Contract's order quantity. 1.5, alongside a 5-ships-per-location fleet, is the minimum-fleet-size combination found via seed-averaged sweeps (see analysis.ts) that keeps the stockpile-vs-minimum metric at or above 1.0 on average. */
export const CONTRACT_QUANTITY_MULTIPLIER = 1.5;

/** Default days an unclaimed Contract stays open before pruneContracts expires it. */
export const DEFAULT_CONTRACT_EXPIRY_DAYS = 7;

/** Default fraction of minStockpile at which an unclaimed Contract is force-replaced before its expiry (see pruneContracts). */
export const DEFAULT_SEVERE_DEFICIT_FRACTION = 0.5;

export interface Contract {
  location: string;
  commodity: string;
  quantity: number;
  /** Fixed payment on top of the fuel reimbursement -- agreed once at contract creation (scaled by shortage urgency, see tenderContracts), immune to later market-price swings. */
  deliveryFee: number;
  /** null until a Company claims it; permanent once claimed (contracts are never re-negotiated or dropped, only fulfilled). */
  company: Faction | null;
  /** The captain currently carrying cargo against this contract, if any -- prevents piling a second shipment onto an already-committed delivery. */
  inFlightCaptain: Captain | null;
  /** Set true once delivered; pruneContracts removes fulfilled contracts from the active list. */
  fulfilled: boolean;
  /** Day this contract was tendered. */
  beginDay: number;
  /** Day an unclaimed contract expires and is removed by pruneContracts. */
  expiryDay: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
 * Tender a fresh one-shot Contract for every (Location, consumed commodity)
 * pair that currently needs restocking (`Location.needsContractRestock`),
 * isn't already covered by an open contract in `openContracts`, and whose
 * Location isn't broke (cash <= 0, per `location.cash`). `quantity` is the
 * Location's own minimum-stockpile target times `quantityMultiplier`.
 * `deliveryFee` is `baseFeeRate` of goods value, scaled up by an exponential
 * urgency curve based on how far *below* (not above) the minimum the
 * current stockpile actually is -- flat `baseFeeRate` anywhere in the
 * proactive 100%-150% zone, ramping toward `baseFeeRate * feeEscalationBase`
 * as stock approaches zero. Called at the very start of each simulated day
 * (see World.runDay), before Factions act, against whatever
 * `pruneContracts` left open.
 */
export function tenderContracts(
  locations: Location[],
  openContracts: readonly Contract[],
  day: number,
  options: TenderContractsOptions = {},
): Contract[] {
  const {
    expiryDays = DEFAULT_CONTRACT_EXPIRY_DAYS,
    baseFeeRate = CONTRACT_BASE_FEE_RATE,
    feeEscalationBase = CONTRACT_FEE_ESCALATION_BASE,
    quantityMultiplier = CONTRACT_QUANTITY_MULTIPLIER,
  } = options;

  const open = new Set(openContracts.map((c) => `${c.location}::${c.commodity}`));
  const contracts: Contract[] = [];
  for (const location of locations) {
    if (location.cash <= 0) continue;
    for (const commodity of Object.keys(location.consumedCommodities)) {
      if (open.has(`${location.name}::${commodity}`)) continue;
      if (!location.needsContractRestock(commodity)) continue;

      const minQuantity = location.minStockpiles[commodity] ?? 0;
      if (minQuantity <= 0) continue;
      const quantity = minQuantity * quantityMultiplier;

      const stock = location.stockpiles[commodity] ?? 0;
      const deficitRatio = Math.max(0, Math.min(1, (minQuantity - stock) / minQuantity));
      const feeMultiplier = feeEscalationBase ** deficitRatio;

      const basePrice = location.basePrices[commodity] ?? 0;
      const deliveryFee = round2(quantity * basePrice * baseFeeRate * feeMultiplier);

      contracts.push({
        location: location.name,
        commodity,
        quantity,
        deliveryFee,
        company: null,
        inFlightCaptain: null,
        fulfilled: false,
        beginDay: day,
        expiryDay: day + expiryDays,
      });
    }
  }
  return contracts;
}

/**
 * Drop fulfilled contracts, expired unclaimed contracts, and unclaimed
 * contracts whose Location has fallen to `severeDeficitFraction` of its
 * minimum stockpile (removed immediately rather than waiting on expiry --
 * `tenderContracts`, called right after in World.runDay, replaces it with a
 * fresh, more urgently-priced offer the same pass). A claimed contract is
 * never auto-removed -- "not picked up" only describes unclaimed ones.
 */
export function pruneContracts(
  contracts: readonly Contract[],
  locations: Location[],
  day: number,
  severeDeficitFraction: number = DEFAULT_SEVERE_DEFICIT_FRACTION,
): Contract[] {
  const byName = new Map(locations.map((l) => [l.name, l]));
  return contracts.filter((c) => {
    if (c.fulfilled) return false;
    if (c.company !== null) return true;
    if (day > c.expiryDay) return false;

    const location = byName.get(c.location);
    const min = location?.minStockpiles[c.commodity] ?? 0;
    const stock = location?.stockpiles[c.commodity] ?? 0;
    return !(min > 0 && stock <= severeDeficitFraction * min);
  });
}
