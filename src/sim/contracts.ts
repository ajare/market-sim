/**
 * Contract: a standing supply agreement between a Location and whichever
 * Company claims it -- "deliver `quantityPerDelivery` of `commodity` every
 * `intervalDays` days," paid via full cost reimbursement (stock + fuel) plus
 * a fixed delivery fee. One Contract is offered per (Location, consumed
 * commodity) pair; only a `Company` (not a `SoloTrader`) will claim one --
 * see `Faction.acceptsContracts` -- and `Company.directFleet` prioritizes
 * servicing claimed contracts over independent arbitrage.
 *
 * The Location's side of the trade is never cash-constrained (an infinite
 * pool, per design): fulfilling a contract is just crediting the Company's
 * cash on delivery, with no balance ever deducted from the Location.
 */
import type { Location } from "./location";
import type { Faction } from "./faction";
import type { Captain } from "./captain";

export interface Contract {
  location: string;
  commodity: string;
  quantityPerDelivery: number;
  intervalDays: number;
  /** Fixed per-delivery payment on top of reimbursing stock + fuel cost -- agreed once at contract creation, immune to later market-price swings. */
  deliveryFee: number;
  /** null until a Company claims it; permanent once claimed (contracts are never re-negotiated or dropped). */
  company: Faction | null;
  /** Day of the last completed delivery; null if never yet fulfilled. */
  lastDeliveryDay: number | null;
  /** The captain currently carrying cargo against this contract, if any -- prevents piling a second shipment onto an already-committed delivery. */
  inFlightCaptain: Captain | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * One open (unclaimed) Contract per (Location, consumed commodity) pair.
 * quantityPerDelivery mirrors the Location's own minimum-stockpile target,
 * and intervalDays falls out of that target divided by the daily consumption
 * rate -- i.e. roughly the time the buffer takes to run dry, so a contract
 * serviced on schedule keeps stock hovering near its minimum rather than
 * drained to zero between deliveries.
 */
export function generateContracts(locations: Location[]): Contract[] {
  const contracts: Contract[] = [];
  for (const location of locations) {
    for (const [commodity, consumeRate] of Object.entries(location.consumedCommodities)) {
      const quantityPerDelivery = location.minStockpiles[commodity] ?? 0;
      if (quantityPerDelivery <= 0 || consumeRate <= 0) continue;

      const intervalDays = Math.max(1, Math.round(quantityPerDelivery / consumeRate));
      const basePrice = location.basePrices[commodity] ?? 0;
      const deliveryFee = round2(quantityPerDelivery * basePrice * 0.05);

      contracts.push({
        location: location.name,
        commodity,
        quantityPerDelivery,
        intervalDays,
        deliveryFee,
        company: null,
        lastDeliveryDay: null,
        inFlightCaptain: null,
      });
    }
  }
  return contracts;
}
