/**
 * Dijkstra shortest-path routing over the Route network, restricted to
 * whichever Routes a `canUseRoute` predicate accepts. Ported from
 * sim/pathfinding.py.
 *
 * The (unfiltered) adjacency graph is cached per ROUTES Map instance via a
 * WeakMap -- a clean equivalent of Python's `id(routes.ROUTES)`-keyed cache:
 * a wholesale reassignment (setRoutes) naturally gets a fresh cache entry
 * since it's a different Map object.
 */
import { ROUTES, type Route } from "./routes";

type Adjacency = Map<string, Route[]>;

const adjacencyCache = new WeakMap<Map<string, Route>, Adjacency>();

export function primeRouteGraphCache(): Adjacency {
  const cached = adjacencyCache.get(ROUTES);
  if (cached) return cached;

  const adjacency: Adjacency = new Map();
  for (const route of ROUTES.values()) {
    if (!adjacency.has(route.origin)) adjacency.set(route.origin, []);
    adjacency.get(route.origin)!.push(route);
    if (!adjacency.has(route.destination)) adjacency.set(route.destination, []);
    adjacency.get(route.destination)!.push(route);
  }
  adjacencyCache.set(ROUTES, adjacency);
  return adjacency;
}

/** Minimal binary min-heap of (distance, node) pairs, tie-broken by node name. */
class MinHeap {
  private items: Array<[number, string]> = [];

  get size(): number {
    return this.items.length;
  }

  push(item: [number, string]): void {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.lessThan(this.items[i], this.items[parent])) {
        [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
        i = parent;
      } else break;
    }
  }

  pop(): [number, string] | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      for (;;) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        let smallest = i;
        if (left < n && this.lessThan(this.items[left], this.items[smallest])) smallest = left;
        if (right < n && this.lessThan(this.items[right], this.items[smallest])) smallest = right;
        if (smallest === i) break;
        [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
        i = smallest;
      }
    }
    return top;
  }

  private lessThan(a: [number, string], b: [number, string]): boolean {
    if (a[0] !== b[0]) return a[0] < b[0];
    return a[1] < b[1];
  }
}

export function findShortestPath(
  origin: string,
  destination: string,
  canUseRoute: (route: Route) => boolean,
  avoidNodes: ReadonlySet<string> = new Set(),
): Route[] | null {
  if (origin === destination) return [];

  const adjacency = primeRouteGraphCache();
  const distances = new Map<string, number>([[origin, 0.0]]);
  const previous = new Map<string, Route>();
  const visited = new Set<string>();
  const heap = new MinHeap();
  heap.push([0.0, origin]);

  while (heap.size > 0) {
    const [dist, node] = heap.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node === destination) break;

    for (const route of adjacency.get(node) ?? []) {
      if (!canUseRoute(route)) continue;
      const neighbor = route.origin === node ? route.destination : route.origin;
      if (visited.has(neighbor)) continue;
      if (avoidNodes.has(neighbor) && neighbor !== destination) continue;
      const newDist = dist + route.distance;
      if (newDist < (distances.get(neighbor) ?? Infinity)) {
        distances.set(neighbor, newDist);
        previous.set(neighbor, route);
        heap.push([newDist, neighbor]);
      }
    }
  }

  if (!distances.has(destination)) return null;

  const path: Route[] = [];
  let node = destination;
  while (node !== origin) {
    const route = previous.get(node)!;
    path.push(route);
    node = route.destination === node ? route.origin : route.destination;
  }
  path.reverse();
  return path;
}

export function pathNodeSequence(origin: string, path: Route[]): string[] {
  const nodes = [origin];
  let node = origin;
  for (const route of path) {
    node = route.origin === node ? route.destination : route.origin;
    nodes.push(node);
  }
  return nodes;
}
