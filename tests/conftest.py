"""
Loads the CSV fixtures under fixtures/ into real Location, Route, and
Company objects for tests to use, instead of every test depending on the
full procedurally-generated 30-location world in sim.py.
"""
import csv
import os
from dataclasses import replace
from typing import Dict, List, Tuple

import pytest

import sim
from sim import (
    Location, TerminalType, Route, RouteType, Company, SoloTrader, Captain,
    Ship, Train, Plane, Transport, SHIP_CLASSES,
)

_COMPANY_TYPES = {"Company": Company, "SoloTrader": SoloTrader}

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")


def _split(value: str) -> List[str]:
    return [v for v in value.split(";") if v] if value else []


def _price_map(value: str) -> Dict[str, float]:
    prices = {}
    for pair in _split(value):
        commodity, price = pair.split(":")
        prices[commodity] = float(price)
    return prices


def load_fixture_commodities(path: str = None) -> Tuple[List[str], Dict[str, float]]:
    """Load commodity names and their base prices from commodities.csv."""
    path = path or os.path.join(FIXTURES_DIR, "commodities.csv")
    names = []
    base_prices = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            names.append(row["name"])
            base_prices[row["name"]] = float(row["base_price"])
    return names, base_prices


def load_fixture_locations(path: str = None) -> Tuple[List[Location], Dict[str, Tuple[float, float]]]:
    """Load Location objects plus their (x, y) coordinates from locations.csv."""
    path = path or os.path.join(FIXTURES_DIR, "locations.csv")
    locations = []
    coordinates = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            locations.append(Location(
                name=row["name"],
                buyable_commodities=_split(row["buyable_commodities"]),
                sellable_commodities=_split(row["sellable_commodities"]),
                buy_prices=_price_map(row["buy_prices"]),
                sell_prices=_price_map(row["sell_prices"]),
                terminal_types=frozenset(TerminalType[t] for t in _split(row["terminal_types"])),
            ))
            coordinates[row["name"]] = (float(row["x"]), float(row["y"]))
    return locations, coordinates


def load_fixture_routes(path: str = None) -> Dict[frozenset, Route]:
    """
    Load Route objects from routes.csv. Route.__post_init__ derives its
    distance from sim.world_data.LOCATION_COORDINATES, so callers must
    register the fixture locations' coordinates there first -- see the
    fixture_world fixture below, which does this via monkeypatch.
    """
    path = path or os.path.join(FIXTURES_DIR, "routes.csv")
    routes = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            route = Route(origin=row["origin"], destination=row["destination"],
                           route_type=RouteType[row["route_type"]])
            routes[frozenset((route.origin, route.destination))] = route
    return routes


def _build_transport(ship_class: str, name: str) -> Transport:
    if ship_class in SHIP_CLASSES:
        return replace(SHIP_CLASSES[ship_class], name=name)
    if ship_class == "Train":
        return Train(name=name)
    if ship_class == "Plane":
        return Plane(name=name)
    return Ship(name=name)


def _build_crew_row(row: dict) -> Tuple[Transport, Captain, str]:
    transport = _build_transport(row["ship_class"], row["ship_name"])
    captain = Captain(
        name=row["captain_name"],
        home_location=row["home_location"],
        min_daily_return_pct=float(row["min_daily_return_pct"]),
    )
    return transport, captain, row["home_location"]


def load_fixture_companies(path: str = None) -> List[Company]:
    """
    Load Company (or SoloTrader, per an optional company_type column --
    see sim.csv_loaders.load_companies_csv) objects, each owning a fleet
    of (Transport, Captain) pairs (see Faction.__init__), from companies.csv.
    """
    path = path or os.path.join(FIXTURES_DIR, "companies.csv")
    by_company: Dict[str, dict] = {}
    order: List[str] = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            company_name = row["company_name"]
            if company_name not in by_company:
                faction_cls = _COMPANY_TYPES.get(row.get("company_type") or "Company", Company)
                by_company[company_name] = {
                    "starting_cash": float(row["company_starting_cash"]),
                    "crew": [],
                    "faction_cls": faction_cls,
                }
                order.append(company_name)

            by_company[company_name]["crew"].append(_build_crew_row(row))

    return [
        by_company[name]["faction_cls"](
            name=name, crew=by_company[name]["crew"],
            starting_cash=by_company[name]["starting_cash"],
        )
        for name in order
    ]


def load_fixture_pirate_crew(path: str = None) -> Dict[str, List[Tuple[Transport, Captain, str]]]:
    """
    Load (Transport, Captain, home_location) rosters grouped by
    brigade_name from pirate_brigades.csv, returning
    {brigade_name -> [(Transport, Captain, home_location), ...]} rather
    than constructed PirateBrigade instances -- "Rogue Pirates"
    deliberately includes a Train so tests can assert PirateBrigade rejects it.
    """
    path = path or os.path.join(FIXTURES_DIR, "pirate_brigades.csv")
    by_brigade: Dict[str, List[Tuple[Transport, Captain, str]]] = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            by_brigade.setdefault(row["brigade_name"], []).append(_build_crew_row(row))
    return by_brigade


@pytest.fixture
def fixture_pirate_crew() -> Dict[str, List[Tuple[Transport, Captain, str]]]:
    return load_fixture_pirate_crew()


@pytest.fixture
def fixture_world(monkeypatch):
    """
    Registers every fixture location's (x, y) into
    sim.world_data.LOCATION_COORDINATES (monkeypatched onto a copy, so
    it's restored after the test) and returns the fixture Locations,
    Routes, and Companies loaded from fixtures/*.csv. Patching
    sim.world_data (the module that actually owns this dict and that
    distance_between/Route.__post_init__ read it from) rather than the
    `sim.LOCATION_COORDINATES` re-export is what makes this visible to
    Route construction -- see sim/__init__.py's module docstring.
    """
    locations, coordinates = load_fixture_locations()
    merged = dict(sim.world_data.LOCATION_COORDINATES)
    merged.update(coordinates)
    monkeypatch.setattr(sim.world_data, "LOCATION_COORDINATES", merged)

    commodity_names, commodity_base_prices = load_fixture_commodities()

    return {
        "locations": locations,
        "routes": load_fixture_routes(),
        "companies": load_fixture_companies(),
        "commodity_names": commodity_names,
        "commodity_base_prices": commodity_base_prices,
    }
