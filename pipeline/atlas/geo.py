"""Tiny geometry helpers (no GEOS dependency so the pipeline installs anywhere)."""

from __future__ import annotations

import math
from typing import Sequence


def _perp(p: Sequence[float], a: Sequence[float], b: Sequence[float]) -> float:
    if a == b:
        return math.dist(p, a)
    (x, y), (x1, y1), (x2, y2) = p, a, b
    return abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / math.hypot(x2 - x1, y2 - y1)


def simplify_line(coords: list[tuple[float, float]], tol: float = 0.0005, ndigits: int = 5) -> list[list[float]]:
    """Douglas–Peucker simplification (iterative), then round and de-duplicate."""
    if len(coords) <= 2:
        pts = coords
    else:
        keep = [False] * len(coords)
        keep[0] = keep[-1] = True
        stack = [(0, len(coords) - 1)]
        while stack:
            i, j = stack.pop()
            dmax, idx = 0.0, -1
            for k in range(i + 1, j):
                d = _perp(coords[k], coords[i], coords[j])
                if d > dmax:
                    dmax, idx = d, k
            if dmax > tol and idx > 0:
                keep[idx] = True
                stack += [(i, idx), (idx, j)]
        pts = [c for c, k in zip(coords, keep) if k]
    out: list[list[float]] = []
    for x, y in pts:
        r = [round(x, ndigits), round(y, ndigits)]
        if not out or out[-1] != r:
            out.append(r)
    return out


def line_length_km(coords: list[list[float]]) -> float:
    total = 0.0
    for (x1, y1), (x2, y2) in zip(coords, coords[1:]):
        p1, p2 = math.radians(y1), math.radians(y2)
        dp, dl = p2 - p1, math.radians(x2 - x1)
        a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        total += 6371.0 * 2 * math.asin(math.sqrt(a))
    return total


def centroid(geom: dict) -> tuple[float, float] | None:
    """Vertex-average centroid of a (Multi)Polygon — good enough to place a label/marker."""
    t = geom.get("type")
    rings = []
    if t == "Polygon":
        rings = [geom["coordinates"][0]]
    elif t == "MultiPolygon":
        rings = [p[0] for p in geom["coordinates"]]
    pts = [c for r in rings for c in r]
    if not pts:
        return None
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def round_geometry(geom: dict, ndigits: int = 4) -> dict:
    def r(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], ndigits), round(c[1], ndigits)]
        return [r(x) for x in c]

    return {"type": geom["type"], "coordinates": r(geom["coordinates"])}
