"""
Dijkstra shortest-path routing over the Route network, restricted to
whichever Routes a given Transport can actually use (see
Transport.can_use_route). Lets a Captain plan a genuine multi-hop voyage
through intermediate locations -- not just a single direct Route -- when
no direct connection exists (or a longer multi-hop path is cheaper).

The (unfiltered) adjacency graph -- every Route indexed by each of its two
endpoints -- is the expensive part to build (one pass over the whole
network) and is the same for every Transport regardless of what it can
use, so it's built once and cached (see _full_adjacency) rather than
rebuilt on every find_shortest_path call; per-Transport/per-voyage
restrictions (can_use_route, avoid_nodes) are applied cheaply while
walking the cached graph instead. World.__init__ primes this cache once
up front (see World.__init__ / prime_route_graph_cache), so the one real
build happens at World-creation time, not gradually across a captain's
first few route lookups.

The cache is keyed by `id(routes.ROUTES)`, so it stays correct after
main()/CSV loading reassigns that module attribute wholesale (a fresh
ROUTES dict gets a fresh cache entry) -- same reasoning as
get_route/distance_between reading `routes.ROUTES` fresh rather than a
`from .routes import ROUTES` copy.
"""
import heapq
from typing import Callable, Dict, List, Optional

from . import routes as routes_mod
from .routes import Route

_adjacency_cache: Optional[Dict[str, List[Route]]] = None
_adjacency_cache_key: Optional[int] = None


def prime_route_graph_cache() -> Dict[str, List[Route]]:
    """
    Build (or reuse, if `routes.ROUTES` hasn't changed identity since the
    last build) the full adjacency graph and cache it. Called once by
    World.__init__ so the one expensive network-wide pass happens at
    World-creation time; every find_shortest_path call afterwards during
    that World's run reuses this same cached graph.
    """
    global _adjacency_cache, _adjacency_cache_key
    current_routes = routes_mod.ROUTES
    cache_key = id(current_routes)
    if _adjacency_cache is None or _adjacency_cache_key != cache_key:
        adjacency: Dict[str, List[Route]] = {}
        for route in current_routes.values():
            adjacency.setdefault(route.origin, []).append(route)
            adjacency.setdefault(route.destination, []).append(route)
        _adjacency_cache = adjacency
        _adjacency_cache_key = cache_key
    return _adjacency_cache


def find_shortest_path(origin: str, destination: str,
                        can_use_route: Callable[[Route], bool],
                        avoid_nodes: frozenset = frozenset()) -> Optional[List[Route]]:
    """
    Dijkstra's algorithm, weighted by Route.distance, over only the edges
    `can_use_route` accepts (e.g. Transport.can_use_route, so a Train
    never gets offered a leg it would have to sail or fly). `avoid_nodes`
    (e.g. currently CLOSED locations -- see World.closed_locations) are
    never used as an intermediate stop, though `origin`/`destination`
    themselves are exempt even if present, since a caller only plans a
    voyage from/to a location it's already confirmed is open. Returns the
    ordered list of Routes to traverse from `origin` to `destination` --
    empty if they're the same location -- or None if no path exists at
    all for this Transport.
    """
    if origin == destination:
        return []

    adjacency = prime_route_graph_cache()
    distances: Dict[str, float] = {origin: 0.0}
    previous: Dict[str, Route] = {}  # node -> the Route used to first reach it
    visited = set()
    heap: List[tuple] = [(0.0, origin)]

    while heap:
        dist, node = heapq.heappop(heap)
        if node in visited:
            continue
        visited.add(node)
        if node == destination:
            break
        for route in adjacency.get(node, []):
            if not can_use_route(route):
                continue
            neighbor = route.destination if route.origin == node else route.origin
            if neighbor in visited:
                continue
            if neighbor in avoid_nodes and neighbor != destination:
                continue
            new_dist = dist + route.distance
            if new_dist < distances.get(neighbor, float("inf")):
                distances[neighbor] = new_dist
                previous[neighbor] = route
                heapq.heappush(heap, (new_dist, neighbor))

    if destination not in distances:
        return None

    path: List[Route] = []
    node = destination
    while node != origin:
        route = previous[node]
        path.append(route)
        node = route.origin if route.destination == node else route.destination
    path.reverse()
    return path


def path_node_sequence(origin: str, path: List[Route]) -> List[str]:
    """The ordered location names a `path` (as returned by find_shortest_path)
    actually visits, starting with `origin` -- e.g. [A, B, C] for a
    two-leg path A->B->C."""
    nodes = [origin]
    node = origin
    for route in path:
        node = route.destination if route.origin == node else route.origin
        nodes.append(node)
    return nodes
