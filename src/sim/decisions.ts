/**
 * Decision/Choice infrastructure for the exploration game mode -- a generic
 * shape shared by every decision-event kind (not just passage-tax), plus the
 * first concrete decision: a village chieftain's passage-tax negotiation on
 * arrival. See doc/ExploreGameIntegration.md's "Event-driven decisions" and
 * "Passage-tax negotiation decision-event" sections.
 *
 * Deliberately independent of World -- these builders only need an Explorer
 * (and, for passage tax, a Location) to produce a PendingDecision; wiring a
 * built decision into `world.pendingDecision` and pausing the simulation is
 * the caller's job (see World.runDay / Explorer.tick).
 */
import type { Explorer } from "./explorer";
import type { Location } from "./location";
import { primeRouteGraphCache } from "./pathfinding";
import { randRandom } from "./simRandom";
import { clamp01 } from "./utils";

/** State a Choice's eligibility check and resolution read/mutate. Explorer-only for now -- neither existing decision kind needs anything beyond the party's own cash/inventory. */
export interface DecisionState {
  explorer: Explorer;
}

/**
 * One option within a PendingDecision. Advisors are stubbed out for this
 * pass (see doc) -- riskHint is a static string, but resolve() still rolls a
 * real probability where the doc calls for one, so the mechanic isn't fake.
 */
export interface Choice {
  label: string;
  isEligible: (state: DecisionState) => boolean;
  riskHint: string;
  resolve: (state: DecisionState) => void;
}

/** Extensible -- more kinds (VillageEncounter, Illness, ...) are planned; not a sealed union. */
export type DecisionKind = "PassageTax" | "LegChoice";

export interface PendingDecision {
  kind: DecisionKind;
  title: string;
  description: string;
  choices: Choice[];
  explorer: Explorer;
}

/**
 * Resolves `decision` immediately, without ever touching `world.pendingDecision`
 * -- used only for an aiControlled ExpeditionParty's own Explorer (see
 * Explorer.arrive), so more than one Explorer can exist in the same World
 * without an autonomous one's arrival contending for the single global
 * pause slot a player-controlled party still uses. Picks the FIRST eligible
 * choice in the decision's own authored order -- every buildPassageTaxDecision
 * branch lists "Pay" first, so this reads as "pay if affordable, else fall
 * through to whatever's next" rather than a new scoring/AI-policy mechanism.
 */
export function autoResolveDecision(decision: PendingDecision): void {
  const choice = decision.choices.find((c) => c.isEligible({ explorer: decision.explorer }));
  choice?.resolve({ explorer: decision.explorer });
}

// Tunable knobs for the passage-tax negotiation -- see buildPassageTaxDecision.

/** Fraction of the party's cash demanded as tax, when no ruler is present (fixed, non-negotiable -- see the PoliticalEntity-fallback branch). */
export const FALLBACK_PASSAGE_TAX_RATE = 0.05;
/** How much of a gift-eligible commodity is handed over per "Offer gift" choice, capped by what's actually held. */
export const GIFT_QUANTITY_OFFERED = 5;
/** Chance a haggle attempt succeeds (reduces the tax) rather than backfiring (pays full tax, angers the chieftain). */
export const HAGGLE_SUCCESS_PROBABILITY = 0.5;
/** Fraction the tax is cut by on a successful haggle. */
export const HAGGLE_SUCCESS_TAX_REDUCTION = 0.5;
/** Chance refusing passes without further incident, beyond simply not paying. */
export const REFUSE_SAFE_PROBABILITY = 0.4;
/** Extra cash lost (as a fraction of current cash), on top of not paying, when a refusal goes badly. */
export const REFUSE_BAD_OUTCOME_CASH_LOSS_FRACTION = 0.2;
/** Chieftain trust deltas for each outcome -- paying/successful gifts build trust, failed haggles/refusals cost it. */
export const TRUST_DELTA_PAY = 0.05;
export const TRUST_DELTA_GIFT = 0.08;
export const TRUST_DELTA_HAGGLE_SUCCESS = 0.02;
export const TRUST_DELTA_HAGGLE_FAILURE = -0.1;
export const TRUST_DELTA_REFUSE_SAFE = -0.05;
export const TRUST_DELTA_REFUSE_BAD = -0.3;

/**
 * Builds the passage-tax negotiation decision, triggered on arrival at a
 * village -- before any trading, per the design doc. Reads
 * `location.ruler ?? location.politicalEntity`:
 *  - A present ruler (Chieftain) offers all four choices (Pay/Offer gift/
 *    Haggle/Refuse), and their own `trust` shifts persistently with the
 *    outcome.
 *  - PoliticalEntity-only fallback offers just Pay (a fixed, non-negotiable
 *    rate) and Refuse -- no Haggle/Offer-gift. PoliticalEntity has no trust
 *    field in this skeleton, so this branch stays stateless (a known,
 *    accepted gap).
 */
export function buildPassageTaxDecision(explorer: Explorer, location: Location): PendingDecision {
  const ruler = location.ruler;
  const choices: Choice[] = [];

  if (ruler !== null) {
    const demandedAmount = ruler.passageTaxRate * explorer.cash;

    choices.push({
      label: "Pay the demanded amount",
      isEligible: (state) => state.explorer.cash >= demandedAmount,
      riskHint: "No risk -- pays the chieftain's demand in full.",
      resolve: (state) => {
        state.explorer.cash -= demandedAmount;
        ruler.trust = clamp01(ruler.trust + TRUST_DELTA_PAY);
      },
    });

    choices.push({
      label: "Offer a gift instead of cash",
      isEligible: (state) => ruler.giftCategories.some((commodity) => state.explorer.heldQuantity(commodity) > 0),
      riskHint: "Low risk -- trades goods instead of cash; the chieftain may value the gift more or less than a cash payment.",
      resolve: (state) => {
        const commodity = ruler.giftCategories.find((c) => state.explorer.heldQuantity(c) > 0);
        if (commodity === undefined) return;
        const given = Math.min(GIFT_QUANTITY_OFFERED, state.explorer.heldQuantity(commodity));
        state.explorer.removeFromCargo(commodity, given);
        ruler.trust = clamp01(ruler.trust + TRUST_DELTA_GIFT);
      },
    });

    choices.push({
      label: "Haggle the amount down",
      isEligible: () => true,
      riskHint: "Risky -- may lower the tax, but a bad outcome pays in full and angers the chieftain.",
      resolve: (state) => {
        if (randRandom() < HAGGLE_SUCCESS_PROBABILITY) {
          state.explorer.cash = Math.max(0, state.explorer.cash - demandedAmount * (1 - HAGGLE_SUCCESS_TAX_REDUCTION));
          ruler.trust = clamp01(ruler.trust + TRUST_DELTA_HAGGLE_SUCCESS);
        } else {
          state.explorer.cash = Math.max(0, state.explorer.cash - demandedAmount);
          ruler.trust = clamp01(ruler.trust + TRUST_DELTA_HAGGLE_FAILURE);
        }
      },
    });

    choices.push({
      label: "Refuse outright",
      isEligible: () => true,
      riskHint: "Risky -- may anger the chieftain or invite conflict.",
      resolve: (state) => {
        if (randRandom() < REFUSE_SAFE_PROBABILITY) {
          ruler.trust = clamp01(ruler.trust + TRUST_DELTA_REFUSE_SAFE);
        } else {
          state.explorer.cash = Math.max(0, state.explorer.cash * (1 - REFUSE_BAD_OUTCOME_CASH_LOSS_FRACTION));
          ruler.trust = clamp01(ruler.trust + TRUST_DELTA_REFUSE_BAD);
        }
      },
    });

    return {
      kind: "PassageTax",
      title: `${ruler.name} demands passage`,
      description: `${ruler.name}, chieftain of ${location.name}, demands ${demandedAmount.toFixed(2)} for safe passage.`,
      choices,
      explorer,
    };
  }

  // No personal ruler -- fall back to the owning PoliticalEntity: a fixed,
  // non-negotiable rate, no Haggle/Offer-gift, no trust to mutate.
  const demandedAmount = FALLBACK_PASSAGE_TAX_RATE * explorer.cash;
  choices.push({
    label: "Pay the demanded amount",
    isEligible: (state) => state.explorer.cash >= demandedAmount,
    riskHint: "No risk -- a fixed, non-negotiable toll.",
    resolve: (state) => {
      state.explorer.cash -= demandedAmount;
    },
  });
  choices.push({
    label: "Refuse outright",
    isEligible: () => true,
    riskHint: "Risky -- may invite conflict.",
    resolve: (state) => {
      if (randRandom() >= REFUSE_SAFE_PROBABILITY) {
        state.explorer.cash = Math.max(0, state.explorer.cash * (1 - REFUSE_BAD_OUTCOME_CASH_LOSS_FRACTION));
      }
    },
  });

  return {
    kind: "PassageTax",
    title: `Passage toll at ${location.name}`,
    description: `The local authority demands ${demandedAmount.toFixed(2)} for safe passage.`,
    choices,
    explorer,
  };
}

/**
 * Builds the leg-choice decision: one Choice per outgoing Trail route from
 * the Explorer's current node, filtered to routes its PorterParty can
 * actually use. NOT forced/automatic -- the caller (UI) triggers this
 * explicitly ("Choose next leg"), per the design doc. No fog-of-war this
 * pass, so each choice's label shows the real destination name directly.
 */
export function buildLegChoiceDecision(explorer: Explorer): PendingDecision {
  const adjacency = primeRouteGraphCache();
  const candidates = (adjacency.get(explorer.locationName) ?? []).filter(
    (route) => route.routeType === "Trail" && explorer.porterParty.canUseRoute(route),
  );

  const choices: Choice[] = candidates.map((route) => {
    const destination = route.origin === explorer.locationName ? route.destination : route.origin;
    return {
      label: `Head to ${destination}`,
      isEligible: () => true,
      riskHint: "Sets out along this trail.",
      resolve: (state) => {
        state.explorer.departFor(route);
      },
    };
  });

  return {
    kind: "LegChoice",
    title: "Choose the next leg",
    description: `From ${explorer.locationName}, where does the party head next?`,
    choices,
    explorer,
  };
}
