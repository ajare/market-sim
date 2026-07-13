/**
 * De Casteljau Bezier evaluation/sampling, shared by the simulation engine
 * (src/sim/routes.ts's Route, which measures/animates along the curve in
 * world-unit [x,y] tuples) and the editor (types.ts's routeRenderPoints,
 * which draws the same curve on canvas). Works for a curve of any degree --
 * a Route's control-point count isn't locked to any particular number.
 */
export type Point = readonly [number, number];

/** Points sampled evenly in Bezier parameter t along a curve, used both as the polyline a Route/canvas draws and as the lookup table a Transport walks at a constant-speed fraction of the curve's actual (arc-length) distance. */
export const CURVE_SAMPLE_COUNT = 24;

/** De Casteljau evaluation at parameter `t` -- works for a Bezier curve of any degree, not just cubic. */
export function bezierPoint(points: readonly Point[], t: number): Point {
  let pts: Point[] = points.slice();
  while (pts.length > 1) {
    const next: Point[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      next.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]);
    }
    pts = next;
  }
  return pts[0];
}

/** `sampleCount + 1` points (t = 0, 1/sampleCount, ..., 1) sampled along the Bezier curve through `points` -- the polyline used to draw/measure a curved Route. */
export function sampleBezierCurve(points: readonly Point[], sampleCount: number = CURVE_SAMPLE_COUNT): Point[] {
  const samples: Point[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    samples.push(bezierPoint(points, i / sampleCount));
  }
  return samples;
}
