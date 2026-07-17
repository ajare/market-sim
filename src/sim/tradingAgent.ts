/**
 * Shared trading-agent math: the destination-first knapsack cargo allocation
 * and route-economics aggregation both Captain (Ships) and Explorer
 * (PorterParty) trade under, so the two apply the SAME rules (price impact,
 * capacity/cash limits, margin-first allocation) without a shared class
 * hierarchy -- ruled out because Captain's `company: FleetOwner` typing, its
 * private `arrive()`, and Sailor's wage/rank/piracy fields all make literal
 * inheritance a bad fit for Explorer, and this codebase already favors free
 * functions over mixins for shared, transport-agnostic math (see
 * transport.ts's crewSpeedFraction). Callers each compute their own cost
 * inputs (see TripCostParams) and their own pathfinding (Captain's full
 * multi-hop Dijkstra vs Explorer's direct-neighbor-only lookup) and pass them
 * in explicitly, rather than these functions calling back onto `this`.
 */
import type { Transport, CargoItem, CargoState } from "./transport";
import { routeTravelDays, type Route, type RouteType } from "./routes";
import { pathNodeSequence } from "./pathfinding";
import { Market, marketKey } from "./markets";
import { round2 } from "./utils";
import type { TradeLogEntry } from "./captain";

/** One commodity's share of a planned or executed trade route -- see TradeDirective/findBestBundle's knapsack allocation. */
export interface CargoAllocation {
  commodity: string;
  quantity: number;
  buyPrice: number;
  sellPriceEstimate: number;
}

export interface RouteEconomics {
  distance: number;
  routeType: string;
  travelDays: number;
  fuelPrice: number;
  fuelUnitsConsumed: number;
  fuelCostPerUnit: number;
  totalCost: number;
  expectedRevenue: number;
  expectedProfit: number;
  dailyReturnPct: number;
  path: Route[] | null;
  crewCost: number;
  /** Combined quantity across every commodity in the bundle -- lets a FleetOwner gauge how much of a route's demand one ship covers, and sizes fuel/capacity the same way a single-commodity quantity used to. */
  quantity: number;
}

export interface TradeDirective extends RouteEconomics {
  destination: string;
  /** The mix of commodities this trip buys here and carries to `destination` -- see findBestBundle's knapsack allocation. */
  items: CargoAllocation[];
}

/**
 * The trading capability Captain and Explorer both bring to this module's
 * free functions -- cash, a single Transport's cargo, a running trade log,
 * per-trade price sensitivity, and the minimum daily-return bar
 * `findBestLocalRoute` requires before committing to a bundle. Purely
 * structural (not a base class -- see this file's own doc comment for why a
 * shared class hierarchy was ruled out): Captain and Explorer already
 * satisfy this today without any changes to either, so declaring it costs
 * nothing and just formalizes what was previously only informal ("Explorer
 * mirrors Captain's X") into something the compiler checks going forward.
 */
export interface Leader {
  cash: number;
  cargo: CargoState | null;
  tradeLog: TradeLogEntry[];
  priceImpact: number;
  minDailyReturnPct: number;
  readonly locationName: string;
  findBestLocalRoute(
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string>,
    excludeRoutes?: ReadonlySet<string>,
  ): TradeDirective | null;
}

/**
 * Per-trip cost inputs a caller supplies instead of these functions looking
 * them up on `this` -- a Ship's are wind/storm/crew-fraction-aware (see
 * Captain), a PorterParty's are simply zero fuel/fixed/crew cost (it burns no
 * fuel and Explorer pays no crew wages).
 */
export interface TripCostParams {
  /** Fuel units per unit distance per unit cargo quantity -- 0 for a PorterParty. */
  fuelConsumptionRate: number;
  /** Flat per-voyage handling fee -- 0 for a PorterParty. */
  fixedShipmentCost: number;
  /** Wages/day for the whole trip -- 0 for a PorterParty (Explorer pays no crew). */
  dailyCrewCost: number;
  /** Effective speed for a leg with this heading (wind/storm/crew-fraction already folded in by the caller) -- headingDeg is null when coordinates are unavailable. */
  speedFn: (headingDeg: number | null) => number;
}

export function excludeRouteKey(commodity: string, location: string): string {
  return `${commodity}||${location}`;
}

/**
 * `items`' combined economics for a voyage along `path` (already computed by
 * the caller -- Captain's full multi-hop Dijkstra search, or Explorer's
 * direct-neighbor-only lookup) -- fuel/capacity scale off the combined
 * quantity across every item, exactly as a single commodity's quantity used
 * to before Round A's multi-item CargoState.
 */
export function routeEconomicsFromPath(
  path: Route[] | null,
  origin: string,
  items: readonly CargoAllocation[],
  fuelPrice: number,
  buyMarkets: Map<string, Market>,
  transport: Transport,
  costParams: TripCostParams,
  headingBetween: (fromName: string, toName: string) => number | null,
): RouteEconomics {
  const quantity = items.reduce((sum, i) => sum + i.quantity, 0);
  const infeasible: RouteEconomics = {
    distance: 0.0, routeType: "unreachable", travelDays: 0,
    fuelPrice, fuelUnitsConsumed: 0.0, fuelCostPerUnit: 0.0,
    totalCost: 0.0, expectedRevenue: 0.0, expectedProfit: -1.0,
    dailyReturnPct: -1.0, path: null, crewCost: 0.0, quantity: 0.0,
  };
  if (path === null || path.length === 0) return infeasible;

  const nodes = pathNodeSequence(origin, path);
  let totalDistance = 0.0;
  let totalDays = 0;
  let totalFuelUnits = 0.0;
  let totalFuelCost = 0.0;
  const routeTypes: RouteType[] = [];

  for (let i = 0; i < path.length; i++) {
    const legOrigin = nodes[i];
    const route = path[i];
    const legDestination = route.origin === legOrigin ? route.destination : route.origin;
    const legFuelUnits = route.distance * costParams.fuelConsumptionRate * quantity;
    if (legFuelUnits > transport.fuelCapacity) return infeasible;

    const legFuelMarket = buyMarkets.get(marketKey(legOrigin, "Fuel"));
    const legFuelPrice = legFuelMarket !== undefined ? legFuelMarket.price : fuelPrice;

    totalDistance += route.distance;
    totalDays += routeTravelDays(route, costParams.speedFn(headingBetween(legOrigin, legDestination)));
    totalFuelUnits += legFuelUnits;
    totalFuelCost += legFuelUnits * legFuelPrice;
    if (!routeTypes.includes(route.routeType)) routeTypes.push(route.routeType);
  }

  const crewCost = costParams.dailyCrewCost * totalDays;
  const goodsCost = items.reduce((sum, i) => sum + i.quantity * i.buyPrice, 0);
  const totalCost = goodsCost + totalFuelCost + costParams.fixedShipmentCost + crewCost;
  const expectedRevenue = items.reduce((sum, i) => sum + i.quantity * i.sellPriceEstimate, 0);
  const expectedProfit = expectedRevenue - totalCost;
  const dailyReturnPct = totalCost > 0 && totalDays > 0 ? expectedProfit / totalCost / totalDays : -1.0;

  return {
    distance: totalDistance,
    routeType: routeTypes.length > 0 ? routeTypes.join("+") : "none",
    travelDays: totalDays,
    fuelPrice,
    fuelUnitsConsumed: totalFuelUnits,
    fuelCostPerUnit: quantity > 0 ? totalFuelCost / quantity : 0.0,
    totalCost,
    expectedRevenue,
    expectedProfit,
    dailyReturnPct,
    path,
    crewCost,
    quantity,
  };
}

interface Candidate {
  commodity: string;
  buyPrice: number;
  availableQuantity: number;
  sellPriceEstimate: number;
  margin: number;
}

/**
 * Greedy knapsack: ranks every commodity profitable to buy at `locationName`
 * and sell at `destination` by per-unit margin (matches this codebase's
 * existing heuristic style elsewhere, e.g. Captain's considerRepositioning,
 * rather than a full DP optimizer), then fills `cargoCapacity`/`cash` across
 * those candidates margin-first.
 */
export function allocateBundleForDestination(
  locationName: string,
  destination: string,
  commodities: readonly string[],
  buyMarkets: Map<string, Market>,
  sellMarkets: Map<string, Market>,
  cash: number,
  cargoCapacity: number,
  excludeRoutes: ReadonlySet<string>,
): CargoAllocation[] {
  const candidates: Candidate[] = [];
  for (const commodity of commodities) {
    if (excludeRoutes.has(excludeRouteKey(commodity, destination))) continue;
    const buyMarket = buyMarkets.get(marketKey(locationName, commodity));
    if (buyMarket === undefined || !buyMarket.isAvailable) continue;
    const sellMarket = sellMarkets.get(marketKey(destination, commodity));
    if (sellMarket === undefined || !sellMarket.isAvailable) continue;
    const margin = sellMarket.price - buyMarket.price;
    if (margin <= 0) continue;
    candidates.push({
      commodity, buyPrice: buyMarket.price, availableQuantity: buyMarket.availableQuantity,
      sellPriceEstimate: sellMarket.price, margin,
    });
  }
  if (candidates.length === 0) return [];
  candidates.sort((a, b) => b.margin - a.margin);

  let remainingCapacity = cargoCapacity;
  let remainingCash = cash;
  const items: CargoAllocation[] = [];
  for (const c of candidates) {
    if (remainingCapacity < 1 || remainingCash < c.buyPrice) continue;
    const quantity = Math.min(remainingCapacity, remainingCash / c.buyPrice, c.availableQuantity);
    if (quantity < 1) continue;
    items.push({ commodity: c.commodity, quantity, buyPrice: c.buyPrice, sellPriceEstimate: c.sellPriceEstimate });
    remainingCapacity -= quantity;
    remainingCash -= quantity * c.buyPrice;
  }
  return items;
}

/**
 * Destination-first knapsack across every candidate destination with at
 * least one available sell market: builds a bundle for each via
 * `allocateBundleForDestination`, costs it out along `findPathTo`'s path via
 * `routeEconomicsFromPath`, and keeps the single best bundle by its own
 * overall `dailyReturnPct`. `findPathTo` is supplied by the caller so this
 * stays agnostic to HOW a path is found (Captain's full Dijkstra vs
 * Explorer's direct-neighbor-only lookup).
 */
export function findBestBundle(
  locationName: string,
  cash: number,
  cargoCapacity: number,
  transport: Transport,
  buyMarkets: Map<string, Market>,
  sellMarkets: Map<string, Market>,
  commodities: readonly string[],
  closedLocations: ReadonlySet<string>,
  excludeRoutes: ReadonlySet<string>,
  minDailyReturnPct: number,
  fuelPrice: number,
  costParams: TripCostParams,
  headingBetween: (fromName: string, toName: string) => number | null,
  findPathTo: (destination: string) => Route[] | null,
): TradeDirective | null {
  const destinations = new Set<string>();
  for (const m of sellMarkets.values()) {
    if (m.locationName !== locationName && !closedLocations.has(m.locationName) && m.isAvailable) {
      destinations.add(m.locationName);
    }
  }
  if (destinations.size === 0) return null;

  let best: TradeDirective | null = null;
  for (const destination of destinations) {
    const items = allocateBundleForDestination(
      locationName, destination, commodities, buyMarkets, sellMarkets, cash, cargoCapacity, excludeRoutes,
    );
    if (items.length === 0) continue;

    const path = findPathTo(destination);
    const econ = routeEconomicsFromPath(path, locationName, items, fuelPrice, buyMarkets, transport, costParams, headingBetween);
    if (econ.expectedProfit <= 0 || econ.dailyReturnPct < minDailyReturnPct) continue;
    if (best === null || econ.dailyReturnPct > best.dailyReturnPct) {
      best = { destination, items, ...econ };
    }
  }
  return best;
}

export interface ExecutedItem {
  commodity: string;
  quantity: number;
  buyPrice: number;
  sellPriceEstimate: number;
  originMarket: Market;
}

/**
 * Re-verifies each item in a planned bundle fresh against current markets/
 * cash/capacity -- the scored bundle from findBestBundle is a plan, not a
 * guaranteed trade, since markets may have shifted since it was scored. Items
 * that fall through (market closed/unavailable, or capacity/cash ran out on
 * an earlier, higher-margin item) are simply left out.
 */
export function reverifyBundle(
  locationName: string,
  plannedItems: readonly CargoAllocation[],
  destination: string,
  cargoCapacity: number,
  cash: number,
  buyMarkets: Map<string, Market>,
  sellMarkets: Map<string, Market>,
): ExecutedItem[] {
  let remainingCapacity = cargoCapacity;
  let remainingCash = cash;
  const executed: ExecutedItem[] = [];
  for (const planned of plannedItems) {
    const originMarket = buyMarkets.get(marketKey(locationName, planned.commodity));
    const sellMarket = sellMarkets.get(marketKey(destination, planned.commodity));
    if (originMarket === undefined || sellMarket === undefined) continue;
    if (!originMarket.isAvailable || !sellMarket.isAvailable) continue;
    const quantity = Math.min(remainingCapacity, remainingCash / originMarket.price, originMarket.availableQuantity, planned.quantity);
    if (quantity < 1) continue;
    executed.push({
      commodity: planned.commodity, quantity, buyPrice: originMarket.price,
      sellPriceEstimate: sellMarket.price, originMarket,
    });
    remainingCapacity -= quantity;
    remainingCash -= quantity * originMarket.price;
  }
  return executed;
}

/**
 * Applies the market-side effects of buying `executed` (price impact,
 * `applyTrade`, the origin Location's cash) -- identical regardless of who's
 * trading, so this is a pure side effect on the markets/Location, never on
 * the buying agent's own cash/cargo (the caller applies those from the
 * returned `goodsCost`/`cargoItems`).
 */
export function applyPurchases(
  executed: readonly ExecutedItem[],
  priceImpact: number,
): { cargoItems: CargoItem[]; goodsCost: number } {
  const cargoItems: CargoItem[] = [];
  let goodsCost = 0;
  for (const e of executed) {
    applyMarketPriceImpact(e.originMarket, e.quantity, "buy", priceImpact);
    e.originMarket.applyTrade(e.quantity);
    e.originMarket.location.cash += e.quantity * e.buyPrice;
    cargoItems.push({ commodity: e.commodity, quantity: e.quantity, unitCost: e.buyPrice, contract: null });
    goodsCost += e.quantity * e.buyPrice;
  }
  return { cargoItems, goodsCost };
}

/** Same price-impact formula Captain has always used, parameterized instead of reading `this.priceImpact`. */
export function applyMarketPriceImpact(market: Market, units: number, direction: "buy" | "sell", priceImpact: number): void {
  if (market.fixedPrice) return;
  const magnitude = (priceImpact * units) / (units + 50.0);
  if (direction === "buy") {
    market.price = market.price * (1 + magnitude);
  } else {
    market.price = Math.max(0.5, market.price * (1 - magnitude));
  }
}

export interface SellLogEntry {
  commodity: string;
  quantity: number;
  price: number;
  profit: number;
}

/**
 * Sells every OPEN-MARKET item in `cargo` that has an available market at
 * `locationName` right now -- an item whose market is closed/unavailable
 * simply stays aboard for another day's attempt rather than blocking the
 * rest of a mixed hold. Contract-bound items are left untouched in
 * `remainingItems` -- the caller (Captain only; Explorer's cargo never
 * contains one) handles those separately. Each item's profit apportions its
 * fair share of the trip's shared fuel/fixed/crew overhead by quantity (0 for
 * every Explorer trade, since it has none), so the sum across every item
 * still equals `totalRevenue - cargo.totalCost` when the whole hold sells
 * together.
 */
export function sellCargoShared(
  locationName: string,
  cargo: CargoState,
  sellMarkets: Map<string, Market>,
  priceImpact: number,
): { realizedProfitDelta: number; proceeds: number; entries: SellLogEntry[]; remainingItems: CargoItem[] } {
  const totalQuantity = cargo.items.reduce((sum, i) => sum + i.quantity, 0);
  const goodsCostTotal = cargo.items.reduce((sum, i) => sum + i.unitCost * i.quantity, 0);
  const overhead = cargo.totalCost - goodsCostTotal;

  let realizedProfitDelta = 0;
  let proceeds = 0;
  const entries: SellLogEntry[] = [];
  const remainingItems: CargoItem[] = [];

  for (const item of cargo.items) {
    if (item.contract !== null) {
      remainingItems.push(item);
      continue;
    }
    const market = sellMarkets.get(marketKey(locationName, item.commodity));
    if (market === undefined || !market.isAvailable) {
      remainingItems.push(item);
      continue;
    }

    const sellPrice = market.price;
    const itemProceeds = sellPrice * item.quantity;
    const itemShareOfOverhead = totalQuantity > 0 ? overhead * (item.quantity / totalQuantity) : 0;
    const profit = itemProceeds - item.unitCost * item.quantity - itemShareOfOverhead;

    applyMarketPriceImpact(market, item.quantity, "sell", priceImpact);
    market.applyTrade(item.quantity);
    market.location.cash -= itemProceeds;

    proceeds += itemProceeds;
    realizedProfitDelta += profit;
    entries.push({ commodity: item.commodity, quantity: round2(item.quantity), price: round2(sellPrice), profit: round2(profit) });
  }

  return { realizedProfitDelta, proceeds, entries, remainingItems };
}

/**
 * A single, freeform trade against `market` -- no voyage/destination
 * involved, unlike everything else in this module. Used by Explorer's manual
 * buy/sell (the player trading while stationed at a village, independent of
 * departing) -- Captain has no equivalent since it only ever trades as part
 * of a directed voyage. Applies the same price-impact formula as a voyage
 * trade; returns the quantity actually bought/sold (0 if nothing could be).
 */
export function buySingleCommodity(
  quantity: number, market: Market, cash: number, remainingCapacity: number, priceImpact: number,
): { quantity: number; cost: number } {
  if (!market.isAvailable || quantity <= 0) return { quantity: 0, cost: 0 };
  const affordable = market.price > 0 ? cash / market.price : Infinity;
  const actualQuantity = Math.min(quantity, affordable, market.availableQuantity, remainingCapacity);
  if (actualQuantity <= 0) return { quantity: 0, cost: 0 };
  const cost = actualQuantity * market.price;
  applyMarketPriceImpact(market, actualQuantity, "buy", priceImpact);
  market.applyTrade(actualQuantity);
  market.location.cash += cost;
  return { quantity: actualQuantity, cost };
}

export function sellSingleCommodity(
  quantity: number, held: number, market: Market, priceImpact: number,
): { quantity: number; proceeds: number } {
  if (!market.isAvailable || quantity <= 0) return { quantity: 0, proceeds: 0 };
  const actualQuantity = Math.min(quantity, held);
  if (actualQuantity <= 0) return { quantity: 0, proceeds: 0 };
  const proceeds = actualQuantity * market.price;
  applyMarketPriceImpact(market, actualQuantity, "sell", priceImpact);
  market.applyTrade(actualQuantity);
  market.location.cash -= proceeds;
  return { quantity: actualQuantity, proceeds };
}
