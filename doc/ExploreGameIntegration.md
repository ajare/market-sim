# Exploration game: integration with existing systems

This document records decisions made while working out how the exploration game mode
(see [ExploreGame.md](./ExploreGame.md)) integrates with the existing `Person` /
`Location` / `Transport` / `World` simulation engine. It is a decisions log, not a
finished spec — sections will be added as more of the design is worked out.

## Context: existing engine (as of this discussion)

- **`Person`** (`src/sim/person.ts`) — base identity for anyone in the world. Always
  either AT a `Location` or ON a `Transport`, never both. `Sailor`/`Captain` are the
  only concrete subtypes today.
- **`Location`** (`src/sim/location.ts`) — a trading hub: stockpiles, prices,
  contracts, `terminalTypes`, daily production/consumption via `dailyUpdate()`.
- **`Transport`** (`src/sim/transport.ts`) — vehicles (`Ship`/`WagonTrain`/`Plane`/etc.)
  restricted to a `RouteType`, moving between `Location`s along `Route`s.
- **`World`** (`src/sim/world.ts`) — owns all `Location`s, runs a single unified
  day-loop (`World.step()`). No mode-switching architecture exists today.
- **Goods** — no generic inventory system. Commodities are string-keyed stockpiles per
  `Location`; a `Captain` carries exactly one `CargoState` at a time.
- **`PoliticalEntity`** (`src/sim/politicalEntity.ts`) — groups `Location`s that share
  one cash balance, typed by scale: `"Universal" | "Planet" | "Country" | "State"`.

## Decisions

### Villages are Locations, not a separate concept

Native villages are modeled as `Location`s, not a new parallel class. They engage in
real trade — natives selling produced goods (furs, ivory, gold, cowrie shells) and
buying imported goods (weapons, textiles, tobacco, alcohol) — using the existing
stockpile/`Market`/`dailyUpdate()` machinery, the same as any other `Location`. Trade at
a village happens between both natives and explorers.

### `Location` gets a settlement-type field

A new field on `Location` — `settlementType: "Native village" | "Settlement" | "Town" | "Outpost"` —
classifies scale/presentation. This is general-purpose, not native-specific: it applies
to European settlements too (the doc's coastal towns, trading posts, inland
settlements).

### New `TerminalType`: `"Market"`

Native villages get a new terminal type, `"Market"`, added to
`packages/shared/src/terminal.ts`'s `TERMINAL_TYPES`. This is distinct from the
settlement-type field above — `TerminalType` describes what transport can connect
there, not the settlement's scale.

### New `RouteType` for overland foot travel

A new `RouteType` (working name: `"Trail"`) for forest-path/porter travel, connecting
`Market`-terminal `Location`s, added alongside the existing `Land`/`Air`/`Sea`/`Space`/
`Road`/`Railroad` types in the same file. `River` was raised as a possible second new
`RouteType` (the doc calls out river travel as more conflict-prone/interceptable than
land trails) but not yet finalized — open follow-up.

### New `TransportType` for the expedition party

A new `TransportType` (working name: `"PorterParty"`) restricted to the new
`Trail` `RouteType`, mirroring how `Lorry` → `Road` or `Ship` → `Sea` work today in
`TRANSPORT_TYPE_ROUTE_TYPES`.

### Ownership stays on `PoliticalEntity`; a new `"Tribe"` type

- `PoliticalEntityType` gets a new value, `"Tribe"`, alongside
  `"Universal" | "Planet" | "Country" | "State"`.
- Many villages belonging to the same tribe **share one `PoliticalEntity`** — a Tribe
  owns many Villages, the same way a Country owns many trading posts today. There is
  **not** a unique `PoliticalEntity` per village.

### Chieftain authority: optional per-Location `ruler`

Native rule doesn't work like Western institutional politics — a village's chieftain
makes the real decisions, not the tribe as an abstract entity. This is modeled as:

- **`Location.ruler?`** — new optional field pointing to a person (the chieftain).
  Likely a `Person` subtype, e.g. `Chieftain`, following the existing pattern of
  `Sailor`/`Captain` extending `Person`.
- Diplomacy-relevant data (trust/suspicion toward the party, danger level, passage tax,
  gift preferences, extortion behavior) lives on the **ruler**, not on
  `PoliticalEntity`.
- **Fallback chain**: if a `Location` has no `ruler`, decisions defer to its owning
  `PoliticalEntity`. If it has a `ruler`, the ruler decides — but may, at their own
  discretion, defer any individual decision to the `PoliticalEntity` instead (e.g. a
  chieftain waiving a personal tax but not overriding a tribe-level treaty).
- This mechanism isn't native-only in principle — the same `ruler` field could later
  model a European city governor overriding a Country's default policy — though that's
  outside this doc's current scope.
- Open follow-up: `Chieftain` and `PoliticalEntity` will likely need a shared
  "decision" interface (trust level, tax rate, etc.) so calling code can treat
  `location.ruler ?? location.politicalEntity` uniformly.

## Inventory system

The expedition needs to carry four kinds of things: consumable supplies (food,
quinine, ammunition), gift/barter goods (cloth, beads, tobacco, weapons given away for
passage/favours), trade cargo (native goods like furs/ivory/gold picked up to sell
later), and equipment (weapons, medical kit, scientific instruments).

### Inventory lives on the Transport, not the Person

The `Explorer` (a new `Person` subtype, analogous to `Captain`) carries nothing
personally — everything is carried by the `PorterParty` `Transport`. Both the capacity
*and* the state live on the `Transport`.

**Required prerequisite change (not exploration-specific):** today `cargoCapacity` is
defined on `Transport`, but the cargo *state* (`CargoState`) lives on `Captain`
instead — an inconsistency across `captain.ts`, `world.ts`, and `faction.ts`. This
needs to change generally, for every `Transport`, not just `PorterParty`: cargo state
should move from `Captain` onto `Transport`, so a `Ship`'s cargo belongs to the `Ship`
itself, independent of whichever `Captain` currently crews it. This is a prerequisite
refactor to the existing simulation (not exploration-mode-specific), tracked here as a
decision but **not yet implemented** — it touches every call site that reads/writes
`captain.cargo` today (`captain.ts`, `world.ts`, `faction.ts`, and related tests) and
should be done as its own dedicated task before or alongside building `PorterParty`.

### One unified stockpile, reusing the Commodity pattern

All four categories above — consumables, gifts, trade goods, and equipment — are
modeled as a single unified stockpile (`Record<commodityId, quantity>`), the same
shape as `Location.stockpiles`, rather than splitting equipment out into a separate
discrete-item list. Simpler and consistent with the rest of the engine, at the cost of
treating a rifle like a bag of beads structurally (differentiated only by weight, see
below).

### Capacity: per-commodity weight, scaled by headcount

- Each `Commodity` gets a weight/bulk-per-unit value (new data on the existing
  `Commodity` registry) — a rifle consumes more capacity than a handful of beads.
  This is a divergence from how `Ship.cargoCapacity` works today, where every unit of
  every commodity counts the same.
- `PorterParty` capacity is a simple sum: `base + (perPorterCapacity × porterCount) +
  (perAnimalCapacity × animalCount)`, mirroring the existing crew-count style used
  elsewhere on `Transport` (e.g. `Transport.crew`). Hiring more porters/pack animals
  raises how much the party can carry.

### Not yet discussed

- Consumption/depletion mechanics: how food/quinine actually get used up daily, and
  how running low drives survival/attrition gameplay.

## Mode boundary

### Shared clock, background sim keeps running

The exploration mode does **not** need a separate simulation loop or clock. While the
player controls an expedition, the rest of the economy (companies trading, weather,
other captains) keeps running in the background on the existing daily tick —
`Explorer`/`PorterParty` becomes just another entity ticked inside `World.step()`,
alongside `Captain`s/`Ship`s, rather than a parallel architecture. The existing
full-day tick resolution is fine for expedition progress too — no finer-grained time
unit is needed.

### No dedicated UI view

The expedition doesn't get its own screen/mode. It's represented within the existing
panel-based `App.tsx` UI (e.g. alongside `NetworkView`/`FleetPanel`), not a separate
map/trek view — consistent with there being no mode-switching architecture in the app
today.

### Control style: hands-on, event-driven

Unlike a `Captain` (set a destination, route resolves automatically), the player makes
explicit choices at key moments — which trail to take, whether to pay/gift a
chieftain's tax, how to respond to an encounter. This matches the interactive
encounters described in [ExploreGame.md](./ExploreGame.md) (chieftain extortion, gift
demands, village safety judgment calls).

## How discovered villages/points of interest render on the map

### Existing precedent: Location icons

`drawLocationIcon` (`NetworkView.tsx:511-524`) picks an icon by `terminalTypes`
priority (Airport plane > Wagon yard wheel > Port/Platform anchor > depot barrel),
colored by owning `PoliticalEntity` (`colorForLocation`). The new `Market` terminal
type (villages) will need its own icon in this same priority scheme.

### Undiscovered villages/POIs are invisible, not vaguely marked

Nothing is drawn for a village/POI the player doesn't yet know about — no silhouette
or "something is here" placeholder. Consistent with the fading-stub route treatment
(a stub just ends; it doesn't hint at what's at the far end either).

### Village discovery is separate from route discovery

Knowing a route leads somewhere (its destination node/position, per "Fog of war"
above) is not the same as knowing a village exists there. A village only renders once
it's **specifically** known to be a village — via advisors or locals telling the
party — independent of whatever route-reveal state applies to the path leading to it.
A discovered route's endpoint could be a plain junction/waypoint as far as the player
knows, until separate intel confirms there's a village there.

## How villages get initially placed/discovered at game start

### Hand-authored, like existing Locations

Native villages are placed deliberately in the editor/world JSON, the same way
coastal trading posts already are — not procedurally generated at world-build time.
Full designer control over placement, tribe assignment (which `PoliticalEntity` owns
it), and chieftain personality, consistent with the rest of `worldData.ts`/the editor's
authoring model.

### Some starting knowledge near the coast, via an explicit authored flag

The player doesn't start from zero knowledge — villages near the coast are already
known, reflecting that the existing European trading posts there already have
relationships with nearby villages. Which villages start known is an **explicit
per-village flag in the authored data** (e.g. a `knownAtStart` field), set
deliberately by the designer — not derived/computed from proximity to a coastal
settlement at runtime.

## Illness/disease decision-events

### Scope: only the Explorer's illness pauses the game

Illness is a `PersonEvent`. Crew/porters can still fall ill (affecting party
capacity/morale), but only illness striking the **Explorer specifically** triggers
the blocking decision modal — other party members' illness resolves automatically in
the background, consistent with the earlier decision that `PersonEvent`s fire on "the
Explorer" for pause purposes.

### The Explorer can die from illness

A severe enough outcome can kill the Explorer, ending the expedition — real stakes,
matching the design doc's grim tone ("people would often just lie down by the side of
the path, to die on their own"). Not a soft-capped/protected mechanic.

### Choices

- **Rest and recover** — lose a day (or more) letting the illness run its course;
  safer but costs time/progress.
- **Use quinine/medicine** — only available if the inventory holds quinine (dynamic
  eligibility per the existing inventory system); better recovery odds than resting
  alone.
- **Push on regardless** — keep traveling despite the illness; risks worsening the
  condition, avoids losing time.
- **Consult the party's medical advisor** — an explicit option within this event
  (not just the ambient per-choice advisor commentary already designed) to get the
  medicine-tagged advisor's specific read on the situation before committing to one
  of the other three.

### Wet season raises illness probability

Illness event roll probability is modified by the existing weather/storm system's
wet/dry season state, per the design doc ("disease is much more rife in the wet
season") — ties disease risk to something already simulated rather than a flat,
constant rate.

## Village encounter event (pre-arrival)

### Scope: whether to approach/enter at all

Distinct from passage-tax negotiation (which fires on arrival) — this is the earlier
decision of whether to approach a village at all, per the design doc's "which
habitations are safe" theme (spy suspicion, locals warning travelers away).

### Fires as a separate event, once approaching

Not folded into the leg-choice decision itself — picking a village as the next leg
just sets the party moving toward it; a distinct "approaching the village" event
fires afterward, before actual arrival, with its own choices.

### Choices

- **Enter openly** — proceed directly into the village; baseline option, leads into
  the passage-tax negotiation event on arrival.
- **Send a scout ahead first** — costs a day's delay; the scouted party member
  personally risks their own `PersonEvent` (captured, hurt, or worse), independent of
  the rest of the party; if it goes well, reveals the village's true danger/trust
  level, reducing reliance on advisor guesswork for this specific decision.
- **Avoid/bypass entirely** — free, just reroutes via an alternate leg, no delay or
  distance cost. Forfeits whatever trade/discovery/advisor opportunities the village
  might have offered, but carries no risk.

This event carries a danger/diplomacy tag like any other decision, so the advisor
panel weighs in per option the same way it does elsewhere — no separate mechanism
needed for risk signaling here beyond what's already designed.

## Passage-tax negotiation decision-event

### Choices offered

Built from the standard `Choice` shape (per "How the decision modal presents
choices"), dynamically filtered by party state as already decided:

- **Pay the demanded amount** — cash, no risk, baseline option (only shown if
  affordable).
- **Offer a gift instead of cash** — substitutes inventory gift-goods for the tax
  (only available if the party is carrying matching gift-category goods).
- **Haggle/negotiate the amount down** — risk of offense if it goes badly, matching
  the design doc's framing of chieftains extorting travelers.
- **Refuse outright** — the riskiest option, may anger the chieftain/tribe, per the
  doc's warnings about theft, arrest, or violence toward those who don't pay.

### Ruler presence changes which choices are available

Whether the village has a `ruler` (chieftain) present, versus falling back to the
owning `PoliticalEntity` alone, changes the option set — not just the mechanical
risk/rates behind them. A present chieftain enables the more personal/flexible
options (haggling, gift substitution); a `PoliticalEntity`-only fallback is more
rigid/institutional, offering fewer or no negotiation options (closer to a fixed,
non-negotiable rate).

### Triggers on arrival, before any trading

The negotiation event fires automatically as soon as the expedition reaches a
village node — not gated behind an attempt to trade. Matches the design doc's framing
that chieftains demand tribute just to let a party pass through, independent of
whether the party intends to trade there at all.

### Outcomes leave a lasting effect

The result (paid, gifted, haggled, refused) persistently shifts trust/danger on the
ruler or `PoliticalEntity`, carrying forward to future visits — refusing today makes
the village riskier next time, generous gifts build goodwill over time. Each visit is
not an independent, memory-less negotiation.

## Event-driven decisions

### No existing prompt/decision infrastructure to build on

Surveyed the existing UI for precedent: there are no modals, dialogs, toasts, or
notification components anywhere in `src/`. The closest analogs are `BuyShipPanel`
(`src/components/BuyShipPanel.tsx`) — an always-visible inline form for a
player-*initiated* discrete action — and `NetworkView`'s map-click placement-menu
popup (position-anchored, no backdrop). Contracts (`src/sim/contracts.ts`,
`ContractsPanel.tsx`) are the closest conceptual analog to a player-facing decision
but are entirely AI-driven today (`Company.acceptContract`/`claimOpenContracts` in
`faction.ts`) with a purely read-only panel — the player has zero interaction with
them currently. `useSimStore` (`src/state/useSimStore.ts`) has no "pending
decision"/event-queue concept; this needs net-new store shape (e.g. a
`pendingDecisions` array plus resolve/dismiss actions).

### Pending decisions pause the whole simulation

While the expedition is traveling with nothing pending, the background economy keeps
running as already decided (see "Mode boundary" above). But the moment the expedition
hits a decision point (chieftain tax demand, village encounter, fork in the trail),
the **entire simulation pauses** — companies, other captains, weather, everything —
until the player resolves it. This refines rather than contradicts the earlier
background-sim decision: normal ticking continues day-to-day, but a pending decision
is the one thing that halts everything.

### UI: new blocking modal

Pending decisions surface via a new blocking modal/dialog — the first modal in the
app. Overlay with backdrop, demands a response before dismissing. This is new UI
infrastructure (nothing like it exists today), a deliberate departure from the
existing inline-panel/popup patterns, chosen because a decision that halts the whole
simulation needs a correspondingly strong attention signal.

### Decisions are driven by the existing (dormant) Event system, split into two kinds

`src/sim/events.ts` already has a `TransportEvent` class (`kind`: `delay` /
`cargo_loss` / `cash_gain` / `cash_loss` / `fuel_discount` / `fixed_cost_discount`,
templates in `AGENT_EVENT_TEMPLATES`), rolled per-day via
`Captain.agentEventProbability`. Two things about the current implementation matter
for this design:

- **It's misfiled today**: despite the event's own `scope` being `"Transport"`, the
  live state (`activeAgentEvents: TransportEvent[]`) lives on `Captain`
  (`captain.ts:251`), not `Transport` — the same Captain-vs-Transport inconsistency
  already flagged for `CargoState`.
- **Random rolling is currently disabled game-wide**: `world.ts:851-853` — no new
  `TransportEvent` (or `MarketEvent`/`CompanyEvent`/`LocationClosure`) is ever rolled
  today; only pre-loaded scenario events still tick down.

Decided:

- Split into two genuine categories: **`PersonEvent`** (things happening to a person —
  illness, injury, etc.) and a true **`TransportEvent`** (things happening to the
  vehicle itself — porters desert, canoe capsizes, pack animal lost), fixing the
  current misfiling rather than just relocating the existing class. `PersonEvent`s are
  tracked on the `Person` they happen to; `TransportEvent`s are tracked on the
  `Transport` they happen to.
- For the expedition specifically: `PersonEvent`s fire on the `Explorer`,
  `TransportEvent`s fire on the `PorterParty`. **Either kind triggers the pause and
  opens the decision modal** when it fires on the player's own Explorer/PorterParty.
- Random event rolling is re-enabled **only** for the new exploration-specific event
  kinds, scoped to `PorterParty`/`Explorer`. The existing (currently dormant) economic
  `AGENT_EVENT_TEMPLATES` rolling for ordinary `Ship`/`WagonTrain` Captains stays
  disabled, untouched by this work.
- This event-storage fix (splitting `PersonEvent`/`TransportEvent` and moving
  Transport-scoped state off `Captain`) is part of the same prerequisite-refactor
  family as the `CargoState` move described above — not exploration-specific in
  principle, but required groundwork for it.

## How the decision modal presents choices

### Choices are dynamically filtered by party state

An option only appears if the party is actually able to take it — e.g. "Pay the tax"
only shows if the party's cash covers it, "Offer a gift" only shows if the inventory
holds a matching gift-category good. This ties directly into the inventory system
above rather than the modal offering options the party can't act on.

### Risk is telegraphed, not hidden or fully numeric

Each choice shows a qualitative risk hint (e.g. "Refuse — risky, may anger the
chieftain") rather than exact mechanical numbers ("-50 cash, +10 trust") or fully
blind narrative framing. Informed but not certain.

### One common Choice shape across every event kind

Every decision — chieftain tax demand, village encounter, trail fork, illness, etc. —
is built from the same generic shape (roughly: `{ label, isEligible(state), riskHint,
resolve(state) }`), rather than each event kind defining bespoke choice
structures/UI. The modal renders any decision uniformly regardless of kind, which
keeps adding new event kinds cheap.

### Risk hints reflect real probabilities, not just flavor

Picking a "risky" choice genuinely rolls against a chance of a worse outcome — the
telegraphed risk hint is an honest signal derived from that same probability, not
narrative dressing over a fixed, deterministic effect.

### Amendment: risk is presented via an advisor panel, not a flat hint

The explorer keeps a panel of trusted advisors — party members (occasionally hired
locals) — who give advice on each decision instead of the modal showing a flat,
mechanically-honest risk hint.

- **Replaces, not supplements**: the previously-decided "honest telegraphed risk hint"
  (above) is replaced entirely. Whatever risk signal the player gets comes only from
  consulting advisors, whose accuracy varies by trust and relevant expertise — e.g.
  the party botanist weighing in on whether a berry is safe to eat.
- **Fixed shared expertise categories**: advisors and decisions are both tagged from
  the same fixed set of expertise domains (e.g. medicine, diplomacy, botany,
  navigation), so which advisors are relevant to a given decision is determined
  automatically rather than ad-hoc/narrative matching.
- **Trust is a visible-but-fallible estimate**: the player sees an apparent
  trust/reputation rating per advisor when choosing them, but that estimate isn't
  perfectly accurate — true reliability can diverge from it and gets revealed through
  experience over time.
- **Drawn from existing party members**: advisors aren't a separate roster/pool —
  they're promoted from the `PorterParty`'s existing crew (reusing the
  `Transport.crew` concept), or occasionally hired at villages/other places.
- **Fixed small number of panel slots**: the explorer can hold only a limited number
  of advisors at once (exact count TBD), forcing a real tradeoff about who to keep —
  consistent with the capacity-constrained inventory design. The explorer can dismiss
  an advisor and pick a new one (or run with fewer/none) at will.

### How advice text gets generated

Advisor opinions are a **noisy estimate of the choice's real underlying odds**, not
independent flavor text — each `Choice`'s true risk probability (from the earlier
probabilistic-resolve decision) exists mechanically regardless of what any advisor
says; an advisor's stated opinion approximates it, with accuracy tied to their
trust/expertise match. An unreliable or mismatched-expertise advisor can be flat-out
wrong.

Text is produced from data-driven template pools, extending the existing
`AGENT_EVENT_TEMPLATES`-style pattern already used in `src/sim/events.ts`, rather than
dynamically assembled sentence fragments:

- **Events carry tags** describing their nature — only events that actually require a
  decision get tags; most existing event kinds (e.g. `MarketEvent`-style commodity
  shocks) don't need advice and have none.
- **Per tag, a bank of advice lines exists per trustworthiness level** — an advisor
  picks from the pool matching (tag × their own trust tier) when responding to a
  decision carrying that tag. The trust tier is what encodes the "noisy estimate" —
  higher-trust pools skew toward accurate lines, lower-trust pools skew toward
  vaguer/misleading ones.
- **Advisors may also have personal, tag-keyed responses** that override the generic
  pool — a canned line they give whenever a matching tag comes up, independent of the
  specific event. It's the advisor's own choice, per decision, whether to use a
  personal line or draw from the generic tag/trust-tier pool.

### Panel slot count

Flat constant: **5** advisor slots, for every expedition regardless of party size,
progression, or reputation. Not tied to headcount or any growth curve.

### Village-hiring mechanics

- **Join as crew first, then promote**: hiring a local at a village doesn't create a
  distinct "direct-to-advisor" hiring flow. The hire joins the `PorterParty`'s
  general crew the same way any other party member does; promotion into one of the 5
  advisor slots works identically regardless of whether the person started as an
  original party member or a village hire.
- **Unconditional, cash/goods transaction**: hiring is independent of the
  chieftain-authority/trust system designed earlier — it's a straightforward
  transaction, not gated by the village's ruler or `PoliticalEntity` trust level. Any
  village might have someone hireable for the right price.
- **Randomly generated per village**: each village procedurally offers a small pool of
  hireable locals, each with randomized expertise domain, trust rating, and price —
  varies per village and presumably per visit, rather than an authored/fixed roster
  (e.g. not directly tied to the village's listed occupations like tanner/blacksmith/
  spinner).
- **Cost scales with quality**: a candidate's price reflects their expertise/trust
  level, consistent with how goods are priced elsewhere in the sim — a highly-rated
  candidate costs more cash/goods to hire than a mediocre one.

### Amendment: hiring vs. the trade/passage-tax system

- **Exempt from passage tax**: hiring a local doesn't incur the chieftain's
  per-loaded-animal trade/passage fee described in the design doc — it's a private
  arrangement with an individual, not formal trade through the village market. No
  chieftain's cut, unlike buying/selling goods there.
- **Revises "unconditional" — hostile villages can block hiring outright**: the
  earlier "independent of trust/danger" framing is narrowed. Price still scales with
  candidate quality regardless of trust, but a chieftain/`PoliticalEntity` with very
  low trust or high danger toward the party can refuse to let locals be hired at all,
  even if the player has the cash — hiring isn't taxed like trade, but it isn't
  entirely free of the diplomacy layer either.

## Expedition movement/pathfinding

### Existing Captain/Transport movement (context)

Today's movement is fully AI-driven end-to-end: `Company.direct`/
`Captain.findBestLocalRoute` (`captain.ts`) algorithmically picks a destination
(never player-chosen), `findShortestPath` (`src/sim/pathfinding.ts`, Dijkstra) computes
the multi-leg `Route[]` path, and the Captain moves hop-by-hop — atomic within each
leg (`daysRemaining` countdown, no interim position tracked mid-leg), but genuinely
stopping at each intermediate node (refuels, vulnerable to storms/pirates) before
continuing to the next leg.

### The expedition reuses the movement mechanics, not the autonomy

- **Same hop-by-hop atomicity**: reuse the existing model as-is — the expedition stops
  fully at each village/node, no interim position tracked mid-leg. No new
  finer-grained progress-tracking system needed.
- **Player picks each leg interactively**: unlike a Captain (destination set
  algorithmically, Dijkstra resolves the whole multi-hop path autonomously), the
  player chooses the expedition's next leg themselves, node by node — no autonomous
  route-planning on the player's behalf.
- **Leg choice is modeled as a decision-event**, reusing the Choice/advisor/
  decision-modal system already designed rather than being a separate dedicated UI
  (e.g. a distinct map-click flow like `NetworkView`'s placement-menu). Arriving at a
  node with multiple outgoing routes fires a navigation-tagged event; the available
  choices are the viable next legs, and advisors weigh in per option the same way they
  do for any other tagged decision.

### Fog of war: routes exist but are partially hidden

- **Fixed graph, hidden from the player**: the full Trail/River network is
  predetermined data (like the existing `Route` graph), not procedurally generated at
  discovery time. "Discovery" is purely a player-visibility/UI concept layered over
  data that already exists — consistent, not randomized per playthrough.
- **Routes are partially visible by default**: from a node, the player can see that an
  outgoing route exists, but not where it leads — the destination is unknown until
  revealed.
- **Two ways a route gets fully revealed**:
  - **Free, at a settlement with locals**: if the party is currently stopped at a
    village/settlement that has locals present, they can simply ask — every route out
    of that node becomes fully known at no cost. No advisor needed.
  - **Via a native advisor's local knowledge, at a location with no locals**: if the
    party is at a node without locals (e.g. an uninhabited waypoint), the free-ask
    option isn't available. A route can still be revealed if a **native** advisor in
    the party's panel happens to know that specific area. **Only natives carry route
    knowledge** — a Western advisor, regardless of trust/expertise, can never reveal a
    route this way.
  - Local knowledge is **tied to an advisor's origin** (where they were recruited) —
    a native advisor knows the territory near their home village/tribe, not the whole
    island; a well-traveled advisor doesn't get broader route knowledge just from
    experience.

### Leg-choice event is optional, not forced

The party can rest/stay at a node — trading, recovering, consulting advisors — before
triggering the next-leg navigation decision whenever the player is ready. Arrival at a
multi-route node does not force an immediate choice.

### How routes render

Existing precedent: `NetworkView.tsx` draws routes as full Bezier curves on a canvas
(`traceCurve`, `NetworkView.tsx:783-801`), colored per `RouteType` via `ROUTE_COLORS`
(`NetworkView.tsx:101-108` — e.g. Sea blue `#3b82f6`, Land brown `#b45309`). Drawing a
full curve necessarily draws all the way to its real endpoint, which directly
conflicts with fog-of-war — it would reveal the hidden destination's exact position.

- **Partially-visible routes render as a short stub near the origin, fading out** —
  only the portion of the curve close to the departure node is drawn (faded/dashed),
  then cut off before reaching the real endpoint. Signals "a path leads this way"
  without giving away distance or destination.
- **Once revealed, Trail/River get their own distinct visual styles** — new entries in
  `ROUTE_COLORS` (and an equivalent line-style distinction, e.g. dashed vs solid),
  following the same per-`RouteType` convention every existing route type already has,
  rather than reusing `Land`'s existing style.

## How discovered map data gets shared with the player's log

### Existing precedent: Ship's Log

`Captain.shipLog` (`ShipLogEntry[]`, `captain.ts:118-119, 259`) is a per-Captain,
day-by-day narrative log — `recordShipLog` (`captain.ts:1564-1608`) assembles a list
of clauses each day (arrivals, trades, repairs, agent events, shore leave, or a
fallback "quiet day" line) and joins them into one text entry per day, appended and
trimmed via `trimHistory`, same convention as `tradeLog`/`portfolioHistory`.

### The Explorer gets its own log, following the exact same pattern

The `Explorer` gets an equivalent day-by-day narrative log built the same way as
`recordShipLog` — clauses assembled per day, including discovery narration (routes
revealed, villages reached, advisor consultations, decisions made), joined into one
entry per day. Not a distinct structure; a direct extension of the existing
`ShipLogEntry` convention.

### Log is narrative only; discovery state is tracked separately

The log does **not** double as the source of truth for what's revealed on the map. A
distinct piece of state (e.g. a set of discovered route/location IDs) is what
`NetworkView` actually reads to decide what's drawn as fully revealed vs. a
fading stub (per "How routes render" above); the log entries narrate those same
discovery events in prose, but are not parsed back to determine map visibility.

### Personal-line vs. generic-pool selection rule

Governed by a new per-advisor personality trait (working name: **opinionatedness**)
setting the odds that, for a tag they have a personal line for, the advisor reaches
for their own line instead of the generic tag/trust-tier pool — probabilistic, not a
deterministic "personal always wins" override. Some advisors editorialize more than
others.

This trait is **independent of trust/expertise** — no built-in correlation. An advisor
can be highly trustworthy and highly opinionated, highly trustworthy and rarely
opinionated, or any other combination; they're separate stats.
