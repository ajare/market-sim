"""
CSV world-building: optional file-driven alternatives to the procedurally
generated COMMODITIES/LOCATIONS/ROUTES and the hand-coded fleets main()
builds by default. Every loader here mirrors the fixture-loading helpers
tests/conftest.py uses for pytest, just generalized to build a whole world
(or fleet) rather than a small hand-authored test one.
"""
import csv
from dataclasses import replace
from typing import Dict, FrozenSet, List, Tuple

from .commodity import Commodity, build_commodities
from .location import Location, TerminalType
from .routes import Route, RouteType
from .transport import Transport, Ship, Train, Plane, SHIP_CLASSES
from .captain import Captain
from .faction import Company, SoloTrader, PirateBrigade

# company_type CSV values recognized by load_companies_csv, beyond the
# default "Company" (a plain, unrecognized/blank value also falls back
# to Company -- see load_companies_csv).
_COMPANY_TYPES: Dict[str, type] = {
    "Company": Company,
    "SoloTrader": SoloTrader,
}


def _split_list(value: str) -> List[str]:
    return [v for v in value.split(";") if v] if value else []


def _parse_float_map(value: str) -> Dict[str, float]:
    numbers = {}
    for pair in _split_list(value):
        commodity, number = pair.split(":")
        numbers[commodity] = float(number)
    return numbers


def load_commodities_csv(path: str) -> Dict[str, Commodity]:
    """
    Load Commodities from a CSV with columns: name,base_price. Only
    base_price is CSV-driven -- price_sensitivity/deficit_price_boost/
    event_templates are filled in by build_commodities, which falls back
    to DEFAULT_PRICE_SENSITIVITY/DEFAULT_DEFICIT_PRICE_BOOST and a generic
    event four-pack for any name it has no hand-tuned entry for (see
    commodity.py).
    """
    names = []
    base_prices = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            names.append(row["name"])
            base_prices[row["name"]] = float(row["base_price"])
    return build_commodities(names, base_prices)


def load_locations_csv(path: str) -> Tuple[List["Location"], Dict[str, Tuple[float, float]]]:
    """
    Load Locations + their (x, y) coordinates from a CSV with columns:
    name,x,y,produced_commodities,consumed_commodities,stockpiles,min_stockpiles,base_prices,fuel_price,terminal_types
    (produced_commodities/consumed_commodities/stockpiles/min_stockpiles/
    base_prices are semicolon-separated "commodity:number" pairs;
    fuel_price is a bare float; terminal_types are TerminalType member names).
    """
    locations = []
    coordinates = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            locations.append(Location(
                name=row["name"],
                produced_commodities=_parse_float_map(row["produced_commodities"]),
                consumed_commodities=_parse_float_map(row["consumed_commodities"]),
                stockpiles=_parse_float_map(row["stockpiles"]),
                min_stockpiles=_parse_float_map(row["min_stockpiles"]),
                base_prices=_parse_float_map(row["base_prices"]),
                fuel_price=float(row["fuel_price"]),
                terminal_types=frozenset(TerminalType[t] for t in _split_list(row["terminal_types"])),
            ))
            coordinates[row["name"]] = (float(row["x"]), float(row["y"]))
    return locations, coordinates


def load_routes_csv(path: str) -> Dict[FrozenSet[str], "Route"]:
    """Load Routes from a CSV with columns: origin,destination,route_type (a RouteType member name)."""
    routes = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            route = Route(origin=row["origin"], destination=row["destination"],
                           route_type=RouteType[row["route_type"]])
            routes[frozenset((route.origin, route.destination))] = route
    return routes


def _build_transport_from_csv(ship_class: str, name: str) -> Transport:
    if ship_class in SHIP_CLASSES:
        return replace(SHIP_CLASSES[ship_class], name=name)
    if ship_class == "Train":
        return Train(name=name)
    if ship_class == "Plane":
        return Plane(name=name)
    return Ship(name=name)


def _build_crew_row(row: dict) -> Tuple[Transport, Captain, str]:
    transport = _build_transport_from_csv(row["ship_class"], row["ship_name"])
    captain = Captain(
        name=row["captain_name"],
        home_location=row["home_location"],
        min_daily_return_pct=float(row["min_daily_return_pct"]),
    )
    return transport, captain, row["home_location"]


def load_companies_csv(path: str) -> List[Company]:
    """
    Load Companies (each owning a fleet of (Transport, Captain) pairs --
    see Faction.__init__) from a CSV with columns:
    company_name,captain_name,ship_name,home_location,ship_class,min_daily_return_pct,company_starting_cash
    (one row per transport; rows sharing a company_name become one Company's fleet).

    An optional `company_type` column selects which Faction subclass to
    build each group as -- "Company" (the default, used if the column is
    absent or blank) or "SoloTrader" (see faction.py: same coordinated
    routing, but each captain keeps their own balance instead of
    pooling). Mixing types across rows of the same company_name isn't
    meaningful -- whichever row's company_type is seen first wins.
    """
    by_company: Dict[str, dict] = {}
    order: List[str] = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            company_name = row["company_name"]
            if company_name not in by_company:
                company_type = _COMPANY_TYPES.get(row.get("company_type") or "Company", Company)
                by_company[company_name] = {
                    "starting_cash": float(row["company_starting_cash"]),
                    "crew": [],
                    "faction_cls": company_type,
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


def load_pirate_brigades_csv(path: str, targets: List[Company]) -> List[PirateBrigade]:
    """
    Load PirateBrigades (each owning a fleet of Ship-only (Transport,
    Captain) pairs -- see Faction.__init__) from a CSV with columns:
    brigade_name,captain_name,ship_name,home_location,ship_class,min_daily_return_pct,brigade_starting_cash
    (one row per transport; rows sharing a brigade_name become one brigade's
    fleet). `targets` is the list of Companies every loaded brigade hunts --
    see PirateBrigade.__init__ for why a non-Ship ship_class here raises.
    """
    by_brigade: Dict[str, dict] = {}
    order: List[str] = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            brigade_name = row["brigade_name"]
            if brigade_name not in by_brigade:
                by_brigade[brigade_name] = {
                    "starting_cash": float(row["brigade_starting_cash"]),
                    "crew": [],
                }
                order.append(brigade_name)

            by_brigade[brigade_name]["crew"].append(_build_crew_row(row))

    return [
        PirateBrigade(name=name, crew=by_brigade[name]["crew"], targets=targets,
                      starting_cash=by_brigade[name]["starting_cash"])
        for name in order
    ]
