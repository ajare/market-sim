"""Generate a hex grid of centers covering a rectangular area.

Usage:
    python scripts/generate_hex_grid.py --width 800 --height 600 --hex-radius 40
    python scripts/generate_hex_grid.py --width 800 --height 600 --hex-radius 40 --orientation flat --output grid.json
"""

import argparse
import json
import math
import random
import sys
from dataclasses import dataclass, replace
from enum import Enum


class Terrain(Enum):
    WATER = "water"
    LAND = "land"


@dataclass(frozen=True)
class HexCenter:
    col: int
    row: int
    x: float
    y: float
    terrain: Terrain = Terrain.WATER


@dataclass(frozen=True)
class Coordinate:
    x: float
    y: float


def generate_hex_grid(
    width: float, height: float, hex_radius: float, orientation: str = "pointy"
) -> list[HexCenter]:
    """Return centers of hexagons (radius `hex_radius`) tiling a width x height area.

    `orientation` is "pointy" (pointy-top hexagons, offset rows) or "flat"
    (flat-top hexagons, offset columns).
    """
    if hex_radius <= 0:
        raise ValueError("hex_radius must be positive")
    if width <= 0 or height <= 0:
        raise ValueError("width and height must be positive")

    centers: list[HexCenter] = []

    if orientation == "pointy":
        horiz_spacing = math.sqrt(3) * hex_radius
        vert_spacing = 1.5 * hex_radius

        row = 0
        y = hex_radius
        while y <= height + hex_radius:
            x_offset = horiz_spacing / 2 if row % 2 else 0
            col = 0
            x = hex_radius + x_offset
            while x <= width + hex_radius:
                if x <= width and y <= height:
                    centers.append(HexCenter(col=col, row=row, x=x, y=y))
                x += horiz_spacing
                col += 1
            y += vert_spacing
            row += 1
    elif orientation == "flat":
        horiz_spacing = 1.5 * hex_radius
        vert_spacing = math.sqrt(3) * hex_radius

        col = 0
        x = hex_radius
        while x <= width + hex_radius:
            y_offset = vert_spacing / 2 if col % 2 else 0
            row = 0
            y = hex_radius + y_offset
            while y <= height + hex_radius:
                if x <= width and y <= height:
                    centers.append(HexCenter(col=col, row=row, x=x, y=y))
                y += vert_spacing
                row += 1
            x += horiz_spacing
            col += 1
    else:
        raise ValueError(f"unknown orientation: {orientation!r}")

    return centers


def assign_land(
    centers: list[HexCenter], land_count: int, rng: random.Random | None = None
) -> list[HexCenter]:
    """Return `centers` with `land_count` randomly chosen hexes marked as land.

    The rest remain water. `land_count` is clamped to the number of centers.
    """
    if land_count < 0:
        raise ValueError("land_count must not be negative")

    rng = rng or random.Random()
    land_count = min(land_count, len(centers))
    land_indices = set(rng.sample(range(len(centers)), land_count))

    return [
        replace(c, terrain=Terrain.LAND) if i in land_indices else c
        for i, c in enumerate(centers)
    ]


def hex_corners(center: HexCenter, hex_radius: float, orientation: str = "pointy") -> list[Coordinate]:
    """Return the 6 corner Coordinates of the hexagon centered on `center`."""
    angle_offset = 30 if orientation == "pointy" else 0
    corners = []
    for i in range(6):
        angle_deg = 60 * i - angle_offset
        angle_rad = math.radians(angle_deg)
        corners.append(
            Coordinate(
                x=round(center.x + hex_radius * math.cos(angle_rad), 9),
                y=round(center.y + hex_radius * math.sin(angle_rad), 9),
            )
        )
    return corners


def generate_coordinates(
    centers: list[HexCenter], hex_radius: float, orientation: str = "pointy"
) -> list[Coordinate]:
    """Return every hex center and corner as a deduplicated list of Coordinates.

    Adjacent hexes share corners, so duplicates (matched on rounded x/y) are
    collapsed while preserving first-seen order.
    """
    seen: dict[tuple[float, float], Coordinate] = {}
    for center in centers:
        center_coord = Coordinate(x=round(center.x, 9), y=round(center.y, 9))
        seen.setdefault((center_coord.x, center_coord.y), center_coord)
        for corner in hex_corners(center, hex_radius, orientation):
            seen.setdefault((corner.x, corner.y), corner)
    return list(seen.values())


def _write_json(centers: list[HexCenter], coordinates: list[Coordinate], stream) -> None:
    json.dump(
        {
            "hexes": [{**c.__dict__, "terrain": c.terrain.value} for c in centers],
            "coordinates": [coord.__dict__ for coord in coordinates],
        },
        stream,
        indent=2,
    )
    stream.write("\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width", type=float, required=True, help="Grid area width")
    parser.add_argument("--height", type=float, required=True, help="Grid area height")
    parser.add_argument("--hex-radius", type=float, required=True, help="Hexagon radius (center to corner)")
    parser.add_argument(
        "--orientation",
        choices=["pointy", "flat"],
        default="pointy",
        help="Hexagon orientation (default: pointy)",
    )
    parser.add_argument(
        "--land-count",
        type=int,
        default=0,
        help="Number of hexes to randomly mark as land (default: 0, all water)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Random seed for land placement (default: nondeterministic)",
    )
    parser.add_argument(
        "--output",
        type=argparse.FileType("w", encoding="utf-8"),
        default=sys.stdout,
        help="Output file (default: stdout)",
    )
    args = parser.parse_args(argv)

    centers = generate_hex_grid(args.width, args.height, args.hex_radius, args.orientation)
    centers = assign_land(centers, args.land_count, random.Random(args.seed))
    coordinates = generate_coordinates(centers, args.hex_radius, args.orientation)
    _write_json(centers, coordinates, args.output)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
