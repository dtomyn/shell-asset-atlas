"""HTTP helpers: an honest User-Agent, retries, and an on-disk cache so re-runs are fast."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import time
import zipfile
from pathlib import Path
from typing import Any, Iterator

import requests

log = logging.getLogger(__name__)

USER_AGENT = "shell-asset-atlas/0.1 (unofficial open-source portfolio project)"
CACHE_DIR = Path(os.environ.get("ATLAS_CACHE", Path(__file__).resolve().parents[1] / ".cache"))
# Cached responses younger than this are reused. CI sets ATLAS_CACHE_TTL=0 to force fresh data.
CACHE_TTL = float(os.environ.get("ATLAS_CACHE_TTL", 7 * 24 * 3600))

_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT


class NotAvailable(RuntimeError):
    """The upstream did not return the expected kind of content (e.g. an HTML error page)."""


def _cache_path(key: str, suffix: str) -> Path:
    digest = hashlib.sha1(key.encode()).hexdigest()[:16]
    return CACHE_DIR / f"{digest}{suffix}"


def fetch(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
    expect: str | None = None,
    timeout: float = 120,
    retries: int = 4,
) -> bytes:
    """GET (or POST when ``data`` is given) with caching and exponential backoff.

    ``expect`` is a substring the Content-Type must contain; this catches portals that
    answer a missing file with a 200 HTML page.
    """
    key = json.dumps([url, params, data], sort_keys=True)
    path = _cache_path(key, ".bin")
    if path.exists() and time.time() - path.stat().st_mtime < CACHE_TTL:
        return path.read_bytes()

    last: Exception | None = None
    for attempt in range(retries):
        try:
            if data is not None:
                r = _session.post(url, params=params, data=data, timeout=timeout)
            else:
                r = _session.get(url, params=params, timeout=timeout)
            if r.status_code in (429, 502, 503, 504):
                raise requests.HTTPError(f"{r.status_code} from {url}")
            r.raise_for_status()
            ctype = r.headers.get("Content-Type", "")
            if expect and expect not in ctype:
                raise NotAvailable(f"{url} returned {ctype!r}, expected {expect!r}")
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            path.write_bytes(r.content)
            return r.content
        except NotAvailable:
            raise
        except Exception as exc:  # network blips, rate limits
            last = exc
            wait = 2 ** attempt * 3
            log.warning("fetch failed (%s), retrying in %ss", exc, wait)
            time.sleep(wait)
    raise RuntimeError(f"giving up on {url}: {last}")


def fetch_json(url: str, **kw: Any) -> Any:
    return json.loads(fetch(url, **kw))


def zip_text(blob: bytes, encoding: str = "latin-1") -> str:
    """Return the text of the single data file inside a zip archive."""
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = max(z.namelist(), key=lambda n: z.getinfo(n).file_size)
        return z.read(name).decode(encoding)


def arcgis_query(
    layer_url: str,
    where: str,
    out_fields: str = "*",
    *,
    geometry: bool = True,
    precision: int | None = 5,
    simplify: float | None = None,
    page_size: int = 1000,
) -> Iterator[dict]:
    """Page through an ArcGIS FeatureServer/MapServer layer and yield GeoJSON features."""
    offset = 0
    while True:
        params: dict[str, Any] = {
            "where": where,
            "outFields": out_fields,
            "returnGeometry": str(geometry).lower(),
            "outSR": 4326,
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": page_size,
            "orderByFields": "OBJECTID",
        }
        if precision is not None:
            params["geometryPrecision"] = precision
        if simplify:
            params["maxAllowableOffset"] = simplify
        page = fetch_json(f"{layer_url}/query", params=params)
        if "error" in page:
            raise RuntimeError(f"ArcGIS error from {layer_url}: {page['error']}")
        feats = page.get("features", [])
        yield from feats
        exceeded = page.get("exceededTransferLimit") or page.get("properties", {}).get("exceededTransferLimit")
        if len(feats) < page_size and not exceeded:
            return
        offset += len(feats)
