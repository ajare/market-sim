"""
main(): builds (procedurally, or from CSVs) a full world/fleet and runs
the simulation end to end -- plus the argparse CLI wrapper around it.

Reassigning world state (COMMODITIES/LOCATIONS/LOCATION_COORDINATES/ROUTES)
is done via the OWNING submodule's attribute (`world_data.LOCATIONS = ...`,
`routes_mod.ROUTES = ...`) rather than a `global` statement here, since
`global` would only rebind a name in THIS module -- every other module's
`distance_between`/`get_route`/etc. would keep reading the old value.
Module-attribute assignment is what every other function (defined in
those modules) actually observes.
"""
import argparse
import os
import random
from dataclasses import replace
from typing import Dict, List, Optional

from sim import world_data
from sim import routes as routes_mod
from sim.world_data import _generate_locations, FUEL_DEPOT_NAMES, ALL_LOCATION_NAMES
from sim.routes import _generate_routes, get_route, RouteType
from sim.transport import SHIP_CLASSES
from sim.captain import Captain
from sim.names import (
    DUTCH_FIRST_NAMES, DUTCH_LAST_NAMES, SPANISH_FIRST_NAMES, SPANISH_LAST_NAMES, random_name,
)
from sim.faction import Company, SoloTrader, PirateBrigade
from sim.csv_loaders import (
    load_commodities_csv, load_locations_csv, load_routes_csv,
    load_companies_csv, load_pirate_brigades_csv,
)
from sim.world import World


def build_world(commodities_csv: Optional[str] = None, locations_csv: Optional[str] = None,
                 routes_csv: Optional[str] = None, companies_csv: Optional[str] = None,
                 pirate_brigades_csv: Optional[str] = None,
                 max_route_distance: Optional[float] = None) -> "tuple[World, List]":
    """
    Builds (procedurally, or from CSVs) a full World plus its list of
    Factions, without printing or running anything -- the world-building
    half of `main()`, split out so other entry points (e.g. exp-ui) can
    construct the same default world without also running 60 days of
    simulation and dumping console reports. See `main()` for what each
    CSV argument does.

    `max_route_distance`, if given, prunes the procedurally generated route
    network down to only pairs of locations within that distance of each
    other (see `_generate_routes`) -- has no effect when `routes_csv` is
    given, since an explicit route file is used as-is.
    """
    if locations_csv is not None:
        world_data.LOCATIONS, world_data.LOCATION_COORDINATES = load_locations_csv(locations_csv)
    elif commodities_csv is not None:
        world_data.COMMODITIES = load_commodities_csv(commodities_csv)
        world_data.LOCATIONS = _generate_locations(ALL_LOCATION_NAMES, world_data.COMMODITIES)

    if routes_csv is not None:
        routes_mod.ROUTES = load_routes_csv(routes_csv)
    elif locations_csv is not None or max_route_distance is not None:
        # The location set changed, or a distance cap was requested -- either
        # way, rebuild the route network procedurally rather than leaving
        # ROUTES pointing at the old, now-mismatched (or uncapped) set.
        routes_mod.ROUTES = _generate_routes(world_data.LOCATIONS, max_distance=max_route_distance)

    # Every non-fuel-depot location name currently in play -- used below to
    # pick home ports for the default (non-CSV) fleets, instead of the
    # stale module-level LOCATION_NAMES, which no longer matches LOCATIONS
    # once a custom locations_csv has replaced it.
    available_home_ports = [loc.name for loc in world_data.LOCATIONS if loc.name not in FUEL_DEPOT_NAMES]

    if companies_csv is not None:
        companies = load_companies_csv(companies_csv)
    else:
        # A 20-transport fleet (or fewer, if the world is smaller than that)
        # spread across the network, organized into 4 companies. Home ports
        # are picked from a shuffled copy of available_home_ports (using a
        # fixed local RNG so the assignment itself is reproducible) so
        # agents are distributed around the map rather than all clustering
        # on the first names. Ship classes cycle through SHIP_CLASSES so
        # each company's fleet has a mix of fast small ships and slow
        # high-capacity ones. Company just wires each already-built
        # Captain's .transport and starting .location onto it (see
        # Faction.__init__) -- we build the (Transport, Captain,
        # home_location) triples ourselves, which is what lets each
        # Captain get its own min_daily_return_pct below.
        fleet_rng = random.Random(99)
        home_ports = fleet_rng.sample(available_home_ports, min(20, len(available_home_ports)))
        ship_class_names = list(SHIP_CLASSES.keys())
        # Captains crewing a Company/SoloTrader fleet get randomized Dutch
        # names (see sim/names.py); the Transport itself keeps its
        # "Ship-NN" identifier regardless of who's captaining it. Each Ship
        # also gets its own random crew_requirement (1-5) -- Faction.__init__
        # pads the roster out with Sailors to match once it takes ownership.
        fleet_crew = [
            (
                replace(
                    SHIP_CLASSES[ship_class_names[i % len(ship_class_names)]],
                    name=f"Ship-{i + 1:02d}", crew_requirement=fleet_rng.randint(1, 5),
                ),
                Captain(
                    name=random_name(fleet_rng, DUTCH_FIRST_NAMES, DUTCH_LAST_NAMES), home_location=home_port,
                    min_daily_return_pct=0.012 + 0.002 * (i % 5),
                    # No starting_cash here -- these ships are handed to a Company
                    # below, which owns the shared cash pool they'll all draw from.
                ),
                home_port,
            )
            for i, home_port in enumerate(home_ports)
        ]

        # "Nordic Cargo Co" and "Pacific Trading Co" are SoloTraders --
        # same coordinated routing as a Company (see Company.direct_fleet),
        # but each captain keeps their own balance instead of pooling
        # (see Faction.pools_cash), so their fleets read as independent
        # operators sharing dispatch rather than one purse.
        company_specs = [
            ("Atlas Shipping", Company),
            ("Meridian Freight", Company),
            ("Nordic Cargo Co", SoloTrader),
            ("Pacific Trading Co", SoloTrader),
        ]
        ships_per_company = max(1, len(fleet_crew) // len(company_specs))
        cash_per_ship = 10_000.0  # same total fleet capital as before, now pooled (or split) per company
        companies = [
            faction_cls(
                name=name,
                crew=fleet_crew[i * ships_per_company:(i + 1) * ships_per_company],
                starting_cash=cash_per_ship * len(fleet_crew[i * ships_per_company:(i + 1) * ships_per_company]),
            )
            for i, (name, faction_cls) in enumerate(company_specs)
            if fleet_crew[i * ships_per_company:(i + 1) * ships_per_company]
        ]

    if pirate_brigades_csv is not None:
        pirate_brigades = load_pirate_brigades_csv(pirate_brigades_csv, targets=companies)
    else:
        # A couple of pirate brigades that hunt the merchant companies rather
        # than trade for themselves -- see PirateBrigade.direct_fleet, which
        # just moves idle pirate ships toward wherever Company ships are
        # currently most concentrated. Speedsters make natural pirate hulls:
        # cheapest and fastest transport class, good for chasing down wherever
        # merchant traffic currently is.
        pirate_rng = random.Random(100)
        pirate_home_ports = pirate_rng.sample(available_home_ports, min(6, len(available_home_ports)))
        pirate_brigade_specs = [
            dict(name="Blackwater Raiders", home_ports=pirate_home_ports[0:3]),
            dict(name="Crimson Corsairs", home_ports=pirate_home_ports[3:6]),
        ]
        pirate_brigades = [
            PirateBrigade(
                name=spec["name"],
                # Pirate captains get randomized Spanish names (see
                # sim/names.py); the Transport itself keeps its
                # "{Brigade}-NN" identifier regardless of who's captaining it.
                crew=[
                    (
                        replace(
                            SHIP_CLASSES["Speedster"], name=f"{spec['name'].split()[0]}-{i + 1:02d}",
                            crew_requirement=pirate_rng.randint(1, 5),
                        ),
                        Captain(
                            name=random_name(pirate_rng, SPANISH_FIRST_NAMES, SPANISH_LAST_NAMES),
                            home_location=home_port,
                        ),
                        home_port,
                    )
                    for i, home_port in enumerate(spec["home_ports"])
                ],
                targets=companies,  # hunt every merchant company in the world
                starting_cash=3_000.0 * len(spec["home_ports"]),
            )
            for spec in pirate_brigade_specs
            if spec["home_ports"]
        ]

    # Every Faction in play -- Companies and PirateBrigades alike -- goes
    # into World's `companies` list; World doesn't care which subclass
    # each one is, it just calls direct_fleet() on whichever ones provide it.
    factions = companies + pirate_brigades

    world = World(
        locations=world_data.LOCATIONS,
        global_event_probability=0.06,
        local_event_probability=0.08,
        location_event_probability=0.04,
        worldwide_event_probability=0.02,
        location_closure_probability=0.015,
        company_event_probability=0.05,
        seed=42,
        factions=factions,
    )

    return world, factions


def main(commodities_csv: Optional[str] = None, locations_csv: Optional[str] = None,
         routes_csv: Optional[str] = None, companies_csv: Optional[str] = None,
         pirate_brigades_csv: Optional[str] = None, json_report_dir: Optional[str] = None):
    """
    Runs the full simulation. With no arguments this builds the same
    procedurally generated 30-location world and hand-coded fleets as
    always. Any of the five world-building pieces can be swapped for a
    file-driven one instead by passing its CSV path (see
    load_commodities_csv / load_locations_csv / load_routes_csv /
    load_companies_csv / load_pirate_brigades_csv for each file's
    expected columns) -- e.g. pass just `locations_csv` to run the default
    procedural fleets over a custom map, or pass all five to run an
    entirely custom world end to end. `commodities_csv` and
    `locations_csv` only take effect together with each other (a custom
    commodity roster regenerates the procedural locations to use it; a
    custom location set already carries its own commodities/prices) --
    `routes_csv`, `companies_csv`, and `pirate_brigades_csv` can each be
    supplied independently of the rest.

    `json_report_dir`, if given, writes every Company's and
    PirateBrigade's full nested daily history (see
    Faction.save_daily_json_report) to that directory, one
    `{faction_slug}_daily_report.json` file per faction.
    """
    world, factions = build_world(
        commodities_csv=commodities_csv, locations_csv=locations_csv, routes_csv=routes_csv,
        companies_csv=companies_csv, pirate_brigades_csv=pirate_brigades_csv,
    )
    companies = [f for f in factions if not isinstance(f, PirateBrigade)]
    pirate_brigades = [f for f in factions if isinstance(f, PirateBrigade)]

    print("=== Locations: what they produce and consume ===")
    for loc in world_data.LOCATIONS:
        buy_str = ", ".join(
            f"{c} @ {world.buy_markets[(loc.name, c)].price:.2f}" for c in loc.produced_commodities
        ) or "(none)"
        sell_str = ", ".join(
            f"{c} @ {world.sell_markets[(loc.name, c)].price:.2f}" for c in loc.consumed_commodities
        ) or "(none)"
        print(f"  {loc.name}")
        print(f"    Produces (buyable):  {buy_str}")
        print(f"    Consumes (sellable): {sell_str}")

    print("\n=== Fleet (by company) ===")
    for company in companies:
        print(f"  {company.name}:")
        for trader in company.captains:
            print(f"    {trader.name:<10} home={trader.location:<20} ship={trader.transport.name:<11} "
                  f"(cap={trader.transport.cargo_capacity:5.1f}, speed={trader.transport.speed_units_per_day:5.0f}/day) "
                  f"min_daily_return_pct={trader.min_daily_return_pct:.3f}")

    print("\n=== Pirate Brigades ===")
    for brigade in pirate_brigades:
        targets_str = ", ".join(c.name for c in brigade.targets)
        print(f"  {brigade.name} (hunting: {targets_str}):")
        for captain in brigade.captains:
            print(f"    {captain.name:<14} home={captain.location:<20} ship={captain.transport.name:<11} "
                  f"(cap={captain.transport.cargo_capacity:5.1f}, speed={captain.transport.speed_units_per_day:5.0f}/day)")

    print("\n=== Route network: transport type breakdown ===")
    type_counts: Dict["RouteType", int] = {}
    for route in routes_mod.ROUTES.values():
        type_counts[route.route_type] = type_counts.get(route.route_type, 0) + 1
    for route_type in list(RouteType):
        print(f"  {route_type:<5}: {type_counts.get(route_type, 0)} routes")

    print("\n=== Arbitrage routes (cheapest buy -> priciest sell, at day 0) ===")
    for commodity in world._commodities_present():
        buy_options = [(loc.name, world.buy_markets[(loc.name, commodity)].price)
                        for loc in world_data.LOCATIONS if loc.can_buy(commodity)]
        sell_options = [(loc.name, world.sell_markets[(loc.name, commodity)].price)
                         for loc in world_data.LOCATIONS if loc.can_sell(commodity)]
        if not buy_options or not sell_options:
            print(f"  {commodity}: not arbitrageable (missing a buy or sell side)")
            continue
        cheap_loc, cheap_price = min(buy_options, key=lambda p: p[1])
        rich_loc, rich_price = max(sell_options, key=lambda p: p[1])
        dist = world_data.distance_between(cheap_loc, rich_loc)
        days = world_data.travel_days_between(cheap_loc, rich_loc)
        route = get_route(cheap_loc, rich_loc)
        route_type = route.route_type if route is not None else "unknown"
        print(f"  {commodity}: buy at {cheap_loc} ({cheap_price:.2f}) -> "
              f"sell at {rich_loc} ({rich_price:.2f}), {dist:.0f} units via {route_type} / {days} day(s)")

    world.run(num_days=60, verbose=True)
    world.print_summary()
    for faction in factions:
        faction.print_summary(world.sell_markets)
        for trader in faction.captains:
            trader.print_summary()
    world.print_daily_agent_log()
    world.print_location_daily_report()
    world.print_company_daily_report()

    if json_report_dir is not None:
        os.makedirs(json_report_dir, exist_ok=True)
        for faction in factions:
            slug = faction.name.lower().replace(" ", "_").replace("-", "_")
            faction.save_daily_json_report(os.path.join(json_report_dir, f"{slug}_daily_report.json"))

    """
    world.save_history_csv("/mnt/user-data/outputs/market_history.csv")
    world.plot_by_commodity("/mnt/user-data/outputs/charts")
    world.plot_agent_comparison("/mnt/user-data/outputs/charts/fleet_comparison_chart.png")
    world.save_daily_agent_log_csv("/mnt/user-data/outputs/daily_agent_log.csv")
    world.save_location_daily_reports_csv("/mnt/user-data/outputs/location_reports")
    world.save_company_daily_reports_csv("/mnt/user-data/outputs/company_reports")

    for trader in fleet:
        slug = trader.name.lower().replace(" ", "_").replace("-", "_")
        trader.save_trade_log_csv(f"/mnt/user-data/outputs/{slug}_trade_log.csv")
        trader.save_agent_event_log_csv(f"/mnt/user-data/outputs/{slug}_agent_events.csv")
        trader.plot_portfolio(f"/mnt/user-data/outputs/charts/{slug}_portfolio_chart.png")
    """

def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Multi-location commodity market agent-based simulation. "
                    "With no arguments, runs the default procedurally generated "
                    "world and hand-coded fleets; any CSV path given below swaps "
                    "that piece for a file-driven one instead (see the matching "
                    "load_*_csv function's docstring for that file's expected columns).",
    )
    parser.add_argument("--commodities-csv", dest="commodities_csv", default=None,
                         help="CSV of commodity names + base prices (columns: name,base_price).")
    parser.add_argument("--locations-csv", dest="locations_csv", default=None,
                         help="CSV of Locations + coordinates (see load_locations_csv).")
    parser.add_argument("--routes-csv", dest="routes_csv", default=None,
                         help="CSV of Routes between locations (columns: origin,destination,route_type).")
    parser.add_argument("--companies-csv", dest="companies_csv", default=None,
                         help="CSV of Companies + their fleets (see load_companies_csv).")
    parser.add_argument("--pirate-brigades-csv", dest="pirate_brigades_csv", default=None,
                         help="CSV of PirateBrigades + their fleets (see load_pirate_brigades_csv).")
    parser.add_argument("--json-report-dir", dest="json_report_dir", default=None,
                         help="If given, write each Company's/PirateBrigade's full nested daily "
                              "history (see Faction.save_daily_json_report) as JSON into this directory.")
    return parser.parse_args(argv)
