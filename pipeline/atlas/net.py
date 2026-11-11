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
# Responses downloaded by this process. Two adapters that read the same file (the BOEM
# production files feed both the Shell series and the peer benchmark) share one download,
# even when the cache lifetime is 0.
_fetched: set[Path] = set()


# Hard ceilings so a misbehaving or hostile upstream cannot exhaust the runner's memory or disk.
MAX_RESPONSE_BYTES = int(os.environ.get("ATLAS_MAX_RESPONSE_MB", 512)) << 20
MAX_UNZIPPED_BYTES = int(os.environ.get("ATLAS_MAX_UNZIPPED_MB", 1024)) << 20

_RETRYABLE = (429, 500, 502, 503, 504)


class NotAvailable(RuntimeError):
    """The upstream did not return the expected kind of content (e.g. an HTML error page),
    or answered 404/410: the file is not there."""


class TooLarge(RuntimeError):
    """A download or archive member exceeded the configured size ceiling."""


class _Permanent(RuntimeError):
    """A client error (4xx other than 404/410/429) that retrying will not fix."""


def _check_status(r: requests.Response, url: str) -> None:
    if r.status_code in _RETRYABLE:
        raise requests.HTTPError(f"{r.status_code} from {url}")
    if r.status_code in (404, 410):
        raise NotAvailable(f"{url} returned {r.status_code}")
    if 400 <= r.status_code < 500:
        raise _Permanent(f"{r.status_code} from {url}")
    r.raise_for_status()


def _read_capped(r: requests.Response, url: str, sink) -> None:
    declared = r.headers.get("Content-Length", "")
    if declared.isdigit() and int(declared) > MAX_RESPONSE_BYTES:
        raise TooLarge(f"{url} is {declared} bytes, over the {MAX_RESPONSE_BYTES} byte limit")
    total = 0
    for chunk in r.iter_content(1 << 20):
        total += len(chunk)
        if total > MAX_RESPONSE_BYTES:
            raise TooLarge(f"{url} exceeded the {MAX_RESPONSE_BYTES} byte limit")
        sink(chunk)


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
    ttl: float | None = None,
) -> bytes:
    """GET (or POST when ``data`` is given) with caching and exponential backoff.

    ``expect`` is a substring the Content-Type must contain; this catches portals that
    answer a missing file with a 200 HTML page. ``ttl`` overrides the cache lifetime in
    seconds (0 = always refetch), for feeds that change by the hour.
    """
    key = json.dumps([url, params, data], sort_keys=True)
    path = _cache_path(key, ".bin")
    if path.exists() and (path in _fetched or time.time() - path.stat().st_mtime < (CACHE_TTL if ttl is None else ttl)):
        return path.read_bytes()

    last: Exception | None = None
    for attempt in range(retries):
        try:
            if data is not None:
                req = _session.post(url, params=params, data=data, timeout=timeout, stream=True)
            else:
                req = _session.get(url, params=params, timeout=timeout, stream=True)
            with req as r:
                _check_status(r, url)
                ctype = r.headers.get("Content-Type", "")
                if expect and expect not in ctype:
                    raise NotAvailable(f"{url} returned {ctype!r}, expected {expect!r}")
                buf = bytearray()
                _read_capped(r, url, buf.extend)
            body = bytes(buf)
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".part")
            tmp.write_bytes(body)
            tmp.replace(path)
            _fetched.add(path)
            return body
        except (NotAvailable, TooLarge):
            raise
        except _Permanent as exc:
            raise RuntimeError(f"giving up on {url}: {exc}") from None
        except Exception as exc:  # network blips, rate limits
            last = exc
            if attempt == retries - 1:
                break
            wait = 2 ** attempt * 3
            log.warning("fetch failed (%s), retrying in %ss", exc, wait)
            time.sleep(wait)
    raise RuntimeError(f"giving up on {url}: {last}")


def fetch_path(url: str, *, expect: str | None = None, timeout: float = 300, retries: int = 4, ttl: float | None = None) -> Path:
    """Like :func:`fetch`, for a file too large to hold in memory: the download is streamed
    into the cache (which is not committed) and the path is returned, so the caller can read
    it piece by piece."""
    path = _cache_path(json.dumps([url, None, None], sort_keys=True), ".bin")
    if path.exists() and (path in _fetched or time.time() - path.stat().st_mtime < (CACHE_TTL if ttl is None else ttl)):
        return path
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with _session.get(url, timeout=timeout, stream=True) as r:
                _check_status(r, url)
                ctype = r.headers.get("Content-Type", "")
                if expect and expect not in ctype:
                    raise NotAvailable(f"{url} returned {ctype!r}, expected {expect!r}")
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".part")
                with tmp.open("wb") as out:
                    _read_capped(r, url, out.write)
                tmp.replace(path)
            _fetched.add(path)
            return path
        except (NotAvailable, TooLarge):
            raise
        except _Permanent as exc:
            raise RuntimeError(f"giving up on {url}: {exc}") from None
        except Exception as exc:  # network blips, rate limits
            last = exc
            if attempt == retries - 1:
                break
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
        return read_member(z, name).decode(encoding)


def read_member(z: zipfile.ZipFile, name: str, limit: int | None = None) -> bytes:
    """Read one archive member without inflating more than ``limit`` bytes (zip-bomb guard).
    The declared size is checked first, then the actual stream, since headers can lie."""
    limit = MAX_UNZIPPED_BYTES if limit is None else limit
    if z.getinfo(name).file_size > limit:
        raise TooLarge(f"zip member {name!r} declares {z.getinfo(name).file_size} bytes, over {limit}")
    out = bytearray()
    with z.open(name) as f:
        while chunk := f.read(1 << 20):
            out.extend(chunk)
            if len(out) > limit:
                raise TooLarge(f"zip member {name!r} inflates past {limit} bytes")
    return bytes(out)


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
        if not feats:
            if exceeded:  # an empty page that claims more would otherwise loop forever
                raise RuntimeError(f"ArcGIS {layer_url} returned an empty page at offset {offset} but flagged more results")
            return
        if len(feats) < page_size and not exceeded:
            return
        offset += len(feats)
