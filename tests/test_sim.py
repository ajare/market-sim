import pytest

from sim import (
    Transport, Ship, Train, Plane, Route, RouteType, LOCATION_NAMES,
    TerminalType, ROUTE_TERMINAL_COMPATIBILITY, Captain, PirateBrigade, SoloTrader, Location,
)

ORIGIN, DESTINATION = LOCATION_NAMES[0], LOCATION_NAMES[1]


def _route(route_type: RouteType) -> Route:
    return Route(origin=ORIGIN, destination=DESTINATION, route_type=route_type)


class TestTransportCanUseRoute:
    def test_generic_transport_allows_any_route_type(self):
        transport = Transport()
        for route_type in RouteType:
            assert transport.can_use_route(_route(route_type)) is True

    def test_missing_route_is_never_usable(self):
        assert Transport().can_use_route(None) is False

    def test_ship_can_only_use_sea_routes(self):
        ship = Ship()
        assert ship.can_use_route(_route(RouteType.Sea)) is True
        assert ship.can_use_route(_route(RouteType.Air)) is False
        assert ship.can_use_route(_route(RouteType.Railroad)) is False

    def test_train_can_only_use_railroad_routes(self):
        train = Train()
        assert train.can_use_route(_route(RouteType.Railroad)) is True
        assert train.can_use_route(_route(RouteType.Sea)) is False
        assert train.can_use_route(_route(RouteType.Air)) is False

    def test_plane_can_only_use_air_routes(self):
        plane = Plane()
        assert plane.can_use_route(_route(RouteType.Air)) is True
        assert plane.can_use_route(_route(RouteType.Sea)) is False
        assert plane.can_use_route(_route(RouteType.Railroad)) is False


class TestFixtureLoading:
    """
    Exercises the CSV-backed fixtures in fixtures/{locations,routes,companies}.csv
    (loaded via the fixture_world fixture in conftest.py) so tests can run
    against a small, hand-authored world instead of the full procedurally
    generated one.
    """

    def test_locations_load_with_expected_shape(self, fixture_world):
        by_name = {loc.name: loc for loc in fixture_world["locations"]}
        assert set(by_name) == {
            "Testport Alpha", "Testport Beta", "Testport Gamma", "Testport Delta",
        }

        alpha = by_name["Testport Alpha"]
        assert alpha.can_buy("Crude Oil")
        assert not alpha.can_sell("Crude Oil")  # Alpha PRODUCES Crude Oil, never consumes it
        assert alpha.fuel_price == 1.20
        assert alpha.terminal_types == frozenset({TerminalType.Port})

        beta = by_name["Testport Beta"]
        assert not beta.can_sell("Wheat")  # starts above its min -- not running low yet

        delta = by_name["Testport Delta"]
        assert delta.can_sell("Wheat")  # starts below its min -- running low, will buy
        assert delta.terminal_types == frozenset({TerminalType.Station})  # no Port -- land-only stop

    def test_routes_are_only_defined_where_terminals_are_compatible(self, fixture_world):
        by_name = {loc.name: loc for loc in fixture_world["locations"]}
        for route in fixture_world["routes"].values():
            required = ROUTE_TERMINAL_COMPATIBILITY[route.route_type]
            assert by_name[route.origin].terminal_types & required
            assert by_name[route.destination].terminal_types & required

    def test_train_can_only_reach_delta_via_the_railroad_route(self, fixture_world):
        train = Train()
        routes = fixture_world["routes"]

        beta_delta = routes[frozenset(("Testport Beta", "Testport Delta"))]
        assert train.can_use_route(beta_delta) is True

        alpha_beta = routes[frozenset(("Testport Alpha", "Testport Beta"))]
        assert train.can_use_route(alpha_beta) is False  # Sea route -- a Train can't use it

    def test_no_route_exists_between_gamma_and_delta(self, fixture_world):
        # Gamma (Port/Airport) and Delta (Station only) share no compatible
        # terminal type, so the fixture simply never defines that pair.
        assert frozenset(("Testport Gamma", "Testport Delta")) not in fixture_world["routes"]

    def test_companies_load_with_expected_fleets(self, fixture_world):
        by_name = {c.name: c for c in fixture_world["companies"]}
        assert set(by_name) == {
            "Fixture Shipping", "Fixture Rail Co", "Fixture Sailing Co", "Fixture Solo Traders",
        }

        # Company just wires each already-built Captain's .transport and
        # starting .location (see Faction.__init__) -- the Captain's own
        # name/strategy came from whoever built it (here, the CSV loader).
        shipping = by_name["Fixture Shipping"]
        assert [c.name for c in shipping.captains] == ["Captain Alice", "Captain Bob"]
        assert shipping.captains[0].transport.name == "Ship-01"
        assert shipping.captains[1].transport.name == "Ship-02"

        rail_co = by_name["Fixture Rail Co"]
        assert isinstance(rail_co.captains[0].transport, Train)

    def test_solo_traders_do_not_pool_cash(self, fixture_world):
        # The company_type column selects SoloTrader instead of Company
        # (see sim.csv_loaders.load_companies_csv) -- same coordinated
        # routing, but no shared cash pool (see Faction.pools_cash).
        solo = next(c for c in fixture_world["companies"] if c.name == "Fixture Solo Traders")
        assert isinstance(solo, SoloTrader)
        assert solo.pools_cash is False

        # company_starting_cash (10,000, taken from the first row seen for
        # this company_type group) is split evenly across the fleet -- see
        # Faction.__init__ -- not pooled, so each captain gets half.
        eve, frank = solo.captains
        assert eve.cash == 5_000.0
        assert frank.cash == 5_000.0
        eve.cash -= 3_000.0
        assert frank.cash == 5_000.0  # untouched -- not pooled

    def test_sailing_vessel_needs_no_fuel(self, fixture_world):
        # SHIP_CLASSES["SailingVessel"] is wind-powered: zero fuel
        # consumption, and current_fuel stays at its default None, so it
        # never needs a refueling stop (see Transport.needs_refuel).
        sailing_co = next(c for c in fixture_world["companies"] if c.name == "Fixture Sailing Co")
        vessel = sailing_co.captains[0].transport
        assert vessel.fuel_consumption_per_unit_distance == 0.0
        assert vessel.reposition_fuel_consumption_per_distance == 0.0
        assert vessel.current_fuel is None
        assert vessel.needs_refuel(99_999) is False

    def test_company_captains_share_one_cash_pool(self, fixture_world):
        shipping = next(c for c in fixture_world["companies"] if c.name == "Fixture Shipping")
        ship_a, ship_b = shipping.captains
        assert ship_a.cash == 10_000.0
        assert ship_b.cash == 10_000.0

        ship_a.cash -= 4_000.0
        assert ship_b.cash == 6_000.0  # same shared pool

    def test_commodities_load_with_expected_base_prices(self, fixture_world):
        assert fixture_world["commodity_names"] == ["Crude Oil", "Wheat", "Gold", "Fuel"]
        assert fixture_world["commodity_base_prices"] == {
            "Crude Oil": 70.00, "Wheat": 6.00, "Gold": 2200.00, "Fuel": 1.20,
        }

    def test_commodity_base_prices_match_location_base_prices(self, fixture_world):
        # Alpha's Crude Oil base_price_modifier is 1.0, so its effective
        # base_price() matches the commodities fixture's base price exactly;
        # fuel_price is a flat per-location price, authored to match too.
        alpha = next(loc for loc in fixture_world["locations"] if loc.name == "Testport Alpha")
        base_prices = fixture_world["commodity_base_prices"]
        assert alpha.base_price("Crude Oil") == base_prices["Crude Oil"]
        assert alpha.fuel_price == base_prices["Fuel"]


class TestPirateBrigadeShipsOnly:
    """
    PirateBrigade owns a fleet of (Transport, Captain, home_location)
    triples (see Faction.__init__ -- callers build each Captain
    themselves; PirateBrigade just wires the Transport/location onto it),
    rejecting the whole fleet at construction time if any Transport isn't
    a Ship -- the ValueError names the offending Captain(s).
    """

    def test_accepts_a_fleet_of_only_ships(self):
        crew = [(Ship(), Captain(name="Pirate-01", home_location="X"), "X")]
        brigade = PirateBrigade(name="Blackwater Raiders", crew=crew, targets=[])
        assert len(brigade.captains) == 1
        assert isinstance(brigade.captains[0].transport, Ship)

    def test_rejects_a_train_in_the_fleet(self):
        crew = [
            (Ship(), Captain(name="Pirate-01", home_location="X"), "X"),
            (Train(), Captain(name="Pirate-02", home_location="X"), "X"),
        ]
        with pytest.raises(ValueError, match="Pirate-02"):
            PirateBrigade(name="Blackwater Raiders", crew=crew, targets=[])

    def test_rejects_a_plane_in_the_fleet(self):
        crew = [(Plane(), Captain(name="Pirate-01", home_location="X"), "X")]
        with pytest.raises(ValueError, match="Pirate-01"):
            PirateBrigade(name="Blackwater Raiders", crew=crew, targets=[])

    def test_fixture_all_ship_roster_is_accepted(self, fixture_pirate_crew):
        crew = fixture_pirate_crew["Fixture Pirates"]
        brigade = PirateBrigade(name="Fixture Pirates", crew=crew, targets=[])
        assert len(brigade.captains) == 2
        assert all(isinstance(c.transport, Ship) for c in brigade.captains)


class TestLocationPlatformIsExclusive:
    """
    A Platform terminal (see Location.__post_init__) can never appear
    alongside any other TerminalType -- it represents an offshore rig with
    no other kind of infrastructure, not just another Sea-compatible stop.
    """

    def _location(self, terminal_types):
        return Location(
            name="Test Rig", produced_commodities={}, consumed_commodities={},
            stockpiles={}, min_stockpiles={}, base_price_modifiers={}, fuel_price=1.25,
            terminal_types=frozenset(terminal_types),
        )

    def test_platform_alone_is_accepted(self):
        location = self._location({TerminalType.Platform})
        assert location.terminal_types == frozenset({TerminalType.Platform})

    def test_platform_with_port_raises(self):
        with pytest.raises(ValueError, match="Test Rig"):
            self._location({TerminalType.Platform, TerminalType.Port})

    def test_platform_with_any_other_terminal_type_raises(self):
        with pytest.raises(ValueError, match="Test Rig"):
            self._location({TerminalType.Platform, TerminalType.Station, TerminalType.Airport})

    def test_fixture_roster_with_a_train_is_rejected(self, fixture_pirate_crew):
        crew = fixture_pirate_crew["Rogue Pirates"]
        with pytest.raises(ValueError, match="Captain Morgan"):
            PirateBrigade(name="Rogue Pirates", crew=crew, targets=[])
