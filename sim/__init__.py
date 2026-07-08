"""
Multi-Location Commodity Market Simulation
===========================================

An agent-based simulation of commodity markets spread across several
locations. See the individual submodules for the pieces:

  - events:       MarketEvent/TransportEvent/CompanyEvent/LocationClosure
  - location:     Location, TerminalType
  - world_data:   the commodity roster, geography (LOCATIONS, get_location, distance_between, ...)
  - routes:       Route/RouteType, the route network
  - pathfinding:  Dijkstra shortest-path routing over the Route network
  - markets:      Market, stockpile-deviation pricing
  - transport:    Transport/Ship/Train/Plane, SHIP_CLASSES
  - crew:         Crew (base class for anyone who operates a Transport) and Sailor (a generic waged deckhand)
  - captain:      Captain (the trading agent, a Crew subclass)
  - names:        random_name() + per-language first/last name pools for naming Captains
  - faction:      Faction/Company/SoloTrader/PirateBrigade/PoliceFleet
  - csv_loaders:  optional CSV-driven world/fleet building
  - world:        World (orchestrates everything, runs the simulation)
  - cli:          main() + argparse wrapper

This top-level module re-exports the public API so `from sim import X`
and `import sim; sim.X` keep working the way they did when this was a
single sim.py file. Run `python -m sim [--commodities-csv ...]` (see
sim/main.py) instead of `python sim.py` now that this is a package.

NOTE for code that needs to see a *reassignment* of world state (e.g.
tests monkeypatching coordinates, or main() swapping in a CSV-loaded
world): patch/reassign the OWNING submodule's attribute --
`sim.world_data.LOCATION_COORDINATES`, `sim.world_data.LOCATIONS`,
`sim.routes.ROUTES` -- not the copy re-exported here on `sim` itself,
since every function that reads these (distance_between, get_route, ...)
looks them up in its own defining module's globals, not this one's.
"""
from . import location
from . import world_data
from . import routes
from . import pathfinding
from . import events
from . import markets
from . import transport
from . import crew
from . import captain
from . import names
from . import faction
from . import csv_loaders
from . import world

from .events import (
    MarketEvent, TransportEvent, CompanyEvent, LocationClosure,
    EVENT_TEMPLATES, AGENT_EVENT_TEMPLATES, COMPANY_EVENT_TEMPLATES,
    LOCATION_EVENT_TEMPLATES, WORLD_EVENT_TEMPLATES, LOCATION_CLOSURE_TEMPLATES,
)
from .location import TerminalType, Location
from .world_data import (
    COMMODITIES, BASE_PRICES, LOCATION_NAMES,
    FUEL_DEPOT_NAMES, ALL_LOCATION_NAMES, WORLD_GEN_SEED, LOCATIONS,
    LOCATION_COORDINATES, SHIP_SPEED_UNITS_PER_DAY,
    distance_between, travel_days_between, get_location,
)
from .routes import (
    RouteType, ROUTE_TERMINAL_COMPATIBILITY, Route, ROUTES, get_route,
)
from .pathfinding import find_shortest_path, path_node_sequence
from .markets import (
    PRICE_SENSITIVITY, DEFAULT_PRICE_SENSITIVITY,
    DEFICIT_PRICE_BOOST, DEFAULT_DEFICIT_PRICE_BOOST, Market,
)
from .transport import Transport, Ship, Train, Plane, SHIP_CLASSES, TransportStatus
from .crew import Crew, Sailor
from .captain import Captain
from .names import (
    random_name, SPANISH_FIRST_NAMES, SPANISH_LAST_NAMES,
    DUTCH_FIRST_NAMES, DUTCH_LAST_NAMES, ENGLISH_FIRST_NAMES, ENGLISH_LAST_NAMES,
)
from .faction import Faction, Company, SoloTrader, PirateBrigade, PoliceFleet
from .csv_loaders import (
    load_commodities_csv, load_locations_csv, load_routes_csv,
    load_companies_csv, load_pirate_brigades_csv,
)
from .world import World, random_agent_order, fixed_agent_order
