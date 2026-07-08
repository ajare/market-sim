"""
Transport: the physical vehicle (capacity, speed, fuel efficiency, fees)
decoupled from the trading agent (Captain) that operates it -- plus its
Ship/Train/Plane subclasses and the off-the-shelf SHIP_CLASSES presets.
"""
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Dict, FrozenSet, List, Optional, TYPE_CHECKING

from .routes import Route, RouteType

if TYPE_CHECKING:
    from .crew import Crew


class TransportStatus(Enum):
    AtLocation = auto()
    InTransit = auto()
    # Its Faction couldn't afford this Transport's crew wages for the day
    # (see Captain.act) -- it stops operating (no fuel burn, no travel
    # progress) and Company/PirateBrigade.direct_fleet() skip it (see
    # Captain.is_idle_in_port, which only returns True for AtLocation)
    # until it becomes affordable again.
    Inactive = auto()


@dataclass
class Transport:
    """
    Base class for any physical vehicle that can carry cargo between
    locations -- the mechanical/economic profile (capacity, speed, fuel
    efficiency, fees) kept separate from Captain's trading
    strategy (risk threshold, price impact, event exposure). The same
    strategy can be paired with different transports to see how the
    hardware alone changes outcomes, and different agents can share a
    transport preset without duplicating its specs.

    By default a Transport is UNRESTRICTED: `allowed_route_types()`
    returns None, meaning it can be routed over a direct Route of any
    type (this is Ship's behavior -- a real cargo transport mostly sails, but
    nothing here stops one from being modeled as multimodal). A subclass
    that's physically confined to one mode -- like Train, which can't
    cross open water or fly -- overrides `allowed_route_types()` to
    return just the type(s) it can actually use; every route-planning
    method on Captain checks `can_use_route()` before treating a
    (origin, destination) pairing as a candidate, so a restricted
    Transport simply never gets offered a pairing it can't reach.
    """
    name: str = "Generic Transport"
    cargo_capacity: float = 20.0                             # max units of cargo carried per voyage
    speed_units_per_day: float = 500.0                       # distance units covered per day
    fuel_consumption_per_unit_distance: float = 0.004        # fuel units per cargo unit per distance unit, loaded
    reposition_fuel_consumption_per_distance: float = 0.04   # fuel units per distance unit, traveling empty (ballast)
    fixed_shipment_cost: float = 15.0                        # flat loading/customs fee per voyage, any cargo size
    fuel_capacity: float = 100.0                             # max fuel units this Transport's tank can hold at once
    status: TransportStatus = TransportStatus.AtLocation          # physical state of the vehicle
    # Live fuel gauge, updated day by day as the Transport travels (see
    # Captain.act / Captain._daily_fuel_burn) and topped up whenever it
    # refuels. None (the default) means this Transport doesn't track fuel
    # at all -- it never needs to refuel, regardless of trip length (see
    # needs_refuel below).
    current_fuel: Optional[float] = None
    # How many Crew members it takes to operate this Transport. Faction
    # (see Faction.__init__) fills this out when a Transport/Captain pair
    # is assigned: the Captain always counts as one of them, and if more
    # than one is required, plain Crew instances pad out the rest, since
    # there's no other information about who they'd be.
    crew_requirement: int = 1
    # The actual roster currently assigned, filled in by Faction.__init__
    # -- empty until then. Length should equal crew_requirement once a
    # Faction has taken ownership of this Transport.
    crew: List["Crew"] = field(default_factory=list)

    def allowed_route_types(self) -> Optional[FrozenSet[str]]:
        """
        Which Route.route_type values this Transport is physically able
        to travel. None (the default) means unrestricted -- any type is
        fine. Override in a subclass that's confined to specific modes.
        """
        return None

    def needs_refuel(self, fuel_required: float) -> bool:
        """
        True if this Transport doesn't currently have `fuel_required`
        units of fuel on board. A Transport with `current_fuel is None`
        never needs refueling (fuel isn't tracked for it at all); this is
        what Captain._route_economics/_find_best_refuel_stop consult to
        decide whether a voyage needs an intermediate refueling stop.
        """
        if self.current_fuel is None:
            return False
        return self.current_fuel < fuel_required

    def consume_fuel(self, amount: float) -> None:
        """Burn `amount` units of fuel today. No-op if fuel isn't tracked (current_fuel is None)."""
        if self.current_fuel is not None:
            self.current_fuel = max(0.0, self.current_fuel - amount)

    def refuel(self, amount: float) -> None:
        """Add `amount` units of fuel to the tank, capped at fuel_capacity. No-op if fuel isn't tracked."""
        if self.current_fuel is not None:
            self.current_fuel = min(self.fuel_capacity, self.current_fuel + amount)

    def can_use_route(self, route: Optional["Route"]) -> bool:
        """
        True if this Transport can travel the given Route. A missing Route
        (None) is treated as unusable -- there's no direct route data to
        confirm this Transport can physically make the trip, so callers
        (see Captain's route-planning methods) correctly skip a
        (origin, destination) pair with no direct connection rather than
        assuming one exists.
        """
        if route is None:
            return False
        allowed = self.allowed_route_types()
        return allowed is None or route.route_type in allowed


@dataclass
class Ship(Transport):
    """
    A sea-going vessel -- the original Transport subclass this
    simulation used; all of the capacity/speed/fuel numbers
    below are just Ship-flavored defaults for the fields Transport
    already defines. Unlike Train (below), Ship does NOT override
    `allowed_route_types()`, so it stays unrestricted and can be routed
    over any direct connection, not just "sea" ones.

    Cargo capacity and speed trade off against each other in practice
    (see SHIP_CLASSES below): a small fast transport can dash short or
    time-sensitive routes but moves less cargo per trip than a slow
    bulk carrier.
    """
    name: str = "Standard Freighter"

    def allowed_route_types(self) -> Optional[FrozenSet["RouteType"]]:
        return frozenset({RouteType.Sea})


@dataclass
class Train(Transport):
    """
    A land-based freight train. Unlike Ship, Train genuinely can't go
    everywhere: it overrides `allowed_route_types()` to permit only
    "land" routes, so Captain's route planning (see
    _find_best_local_route / _consider_repositioning, both of which
    filter candidates through `can_use_route()`) will never offer a
    Train-captained trader a destination it would have to cross open
    water or fly to reach -- it simply isn't considered a candidate at
    all, the same way a closed port isn't.

    Trains trade the transport's flexibility for efficiency on the routes
    they CAN take: cheaper fuel per unit of cargo moved than a
    comparable transport, at the cost of being landlocked.
    """
    name: str = "Freight Train"
    cargo_capacity: float = 25.0
    speed_units_per_day: float = 450.0
    fuel_consumption_per_unit_distance: float = 0.002
    reposition_fuel_consumption_per_distance: float = 0.018
    fixed_shipment_cost: float = 10.0
    fuel_capacity: float = 60.0

    def allowed_route_types(self) -> Optional[FrozenSet["RouteType"]]:
        return frozenset({RouteType.Railroad})


@dataclass
class Plane(Transport):
    """
    A cargo aircraft. Like Train, Plane is genuinely restricted rather
    than just labeled: it overrides `allowed_route_types()` to permit
    only "air" routes, so Captain's route planning (see
    _find_best_local_route / _consider_repositioning, both of which
    filter candidates through `can_use_route()`) will never offer a
    Plane-captained trader a destination it would have to sail or drive
    to reach -- it simply isn't considered a candidate at all, the same
    way a closed port isn't.

    Planes trade capacity and running cost for raw speed: by far the
    fastest transport per distance unit, at a much smaller cargo hold
    and a heavier fuel burn (and pricier landing fee) than a transport or
    train moving the same distance -- worth it for time-sensitive,
    high-value cargo where sitting in transit for days would eat the
    trade's margin.
    """
    name: str = "Cargo Plane"
    cargo_capacity: float = 6.0
    speed_units_per_day: float = 2200.0
    fuel_consumption_per_unit_distance: float = 0.009
    reposition_fuel_consumption_per_distance: float = 0.07
    fixed_shipment_cost: float = 40.0
    fuel_capacity: float = 40.0

    def allowed_route_types(self) -> Optional[FrozenSet["RouteType"]]:
        return frozenset({RouteType.Air})


# A few off-the-shelf classes spanning the capacity/speed/efficiency
# trade-off space. Small and fast burns less fuel per trip but can't move
# much cargo; large and slow moves a lot but ties up more capital per
# voyage and costs more to load.
SHIP_CLASSES: Dict[str, Ship] = {
    "Speedster": Ship(name="Speedster", cargo_capacity=8.0, speed_units_per_day=800.0,
                       fuel_consumption_per_unit_distance=0.003,
                       reposition_fuel_consumption_per_distance=0.025, fixed_shipment_cost=8.0,
                       fuel_capacity=60.0, current_fuel=0.0),
    "Handysize": Ship(name="Handysize", cargo_capacity=12.0, speed_units_per_day=600.0,
                       fuel_consumption_per_unit_distance=0.0035,
                       reposition_fuel_consumption_per_distance=0.03, fixed_shipment_cost=10.0,
                       fuel_capacity=90.0, current_fuel=0.0),
    "Panamax": Ship(name="Panamax", cargo_capacity=20.0, speed_units_per_day=500.0,
                     fuel_consumption_per_unit_distance=0.004,
                     reposition_fuel_consumption_per_distance=0.04, fixed_shipment_cost=15.0,
                     fuel_capacity=140.0, current_fuel=0.0),
    "Capesize": Ship(name="Capesize", cargo_capacity=35.0, speed_units_per_day=400.0,
                      fuel_consumption_per_unit_distance=0.0045,
                      reposition_fuel_consumption_per_distance=0.05, fixed_shipment_cost=25.0,
                      fuel_capacity=220.0, current_fuel=0.0),
    # Wind-powered -- burns no fuel at all (loaded or ballast), and leaves
    # current_fuel at its default None, so Transport.needs_refuel() is
    # always False for it: this class never needs a refueling stop,
    # regardless of trip length. Slower and smaller-holded than its
    # fuel-burning peers, but never pays a fuel cost either.
    "SailingVessel": Ship(name="SailingVessel", cargo_capacity=10.0, speed_units_per_day=300.0,
                           fuel_consumption_per_unit_distance=0.0,
                           reposition_fuel_consumption_per_distance=0.0, fixed_shipment_cost=5.0,
                           fuel_capacity=0.0, current_fuel=None),
}
