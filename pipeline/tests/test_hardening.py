"""Guards added by the security / data-safety review: HTTP status handling, size limits,
pagination, refresh sanity checks and source-specific failure modes."""

import io
import json
import zipfile

import pytest

from atlas import build, net
from atlas.model import SourceResult
from atlas.sources import gom, retail, storms_live


# --- net: status handling ---------------------------------------------------------------
class FakeResponse:
    def __init__(self, status=200, body=b"{}", ctype="application/json", length=None):
        self.status_code = status
        self._body = body
        self.headers = {"Content-Type": ctype}
        if length is not None:
            self.headers["Content-Length"] = str(length)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise net.requests.HTTPError(str(self.status_code))

    def iter_content(self, size):
        for i in range(0, len(self._body), size):
            yield self._body[i : i + size]


@pytest.fixture
def offline(tmp_path, monkeypatch):
    """Point the cache at a temp dir, record calls, and never sleep."""
    monkeypatch.setattr(net, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(net, "_fetched", set())
    monkeypatch.setattr(net.time, "sleep", lambda s: None)
    calls = []

    def install(*responses):
        it = iter(responses)

        def get(url, **kw):
            calls.append(url)
            return next(it)

        monkeypatch.setattr(net._session, "get", get)
        monkeypatch.setattr(net._session, "post", get)
        return calls

    return install


def test_fetch_404_is_not_available_without_retry(offline):
    calls = offline(FakeResponse(404))
    with pytest.raises(net.NotAvailable):
        net.fetch("https://example.test/a", ttl=0)
    assert len(calls) == 1


def test_fetch_403_fails_fast(offline):
    calls = offline(FakeResponse(403))
    with pytest.raises(RuntimeError, match="403"):
        net.fetch("https://example.test/b", ttl=0)
    assert len(calls) == 1


def test_fetch_retries_503_then_succeeds(offline):
    calls = offline(FakeResponse(503), FakeResponse(200, b'{"ok":1}'))
    assert net.fetch("https://example.test/c", ttl=0) == b'{"ok":1}'
    assert len(calls) == 2


def test_fetch_refuses_oversized_body(offline, monkeypatch):
    monkeypatch.setattr(net, "MAX_RESPONSE_BYTES", 10)
    offline(FakeResponse(200, b"x" * 50))
    with pytest.raises(net.TooLarge):
        net.fetch("https://example.test/d", ttl=0)


def test_fetch_refuses_oversized_declared_length(offline, monkeypatch):
    monkeypatch.setattr(net, "MAX_RESPONSE_BYTES", 10)
    offline(FakeResponse(200, b"", length=10_000))
    with pytest.raises(net.TooLarge):
        net.fetch("https://example.test/e", ttl=0)


# --- net: zip and pagination --------------------------------------------------------------
def _zip(name: str, data: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(name, data)
    return buf.getvalue()


def test_zip_text_reads_normal_member():
    assert net.zip_text(_zip("a.txt", b"hello")) == "hello"


def test_read_member_stops_zip_bomb(monkeypatch):
    blob = _zip("bomb.txt", b"\0" * 5_000_000)  # compresses to a few KB
    with zipfile.ZipFile(io.BytesIO(blob)) as z, pytest.raises(net.TooLarge):
        net.read_member(z, "bomb.txt", limit=1_000_000)


def test_arcgis_empty_page_flagged_as_more_does_not_loop(monkeypatch):
    pages = iter([{"features": [], "exceededTransferLimit": True}])
    monkeypatch.setattr(net, "fetch_json", lambda url, **kw: next(pages))
    with pytest.raises(RuntimeError, match="empty page"):
        list(net.arcgis_query("https://example.test/layer", "1=1"))


def test_arcgis_empty_last_page_ends(monkeypatch):
    pages = iter([{"features": [{"id": 1}] * 2, "exceededTransferLimit": True}, {"features": []}])
    monkeypatch.setattr(net, "fetch_json", lambda url, **kw: next(pages))
    assert len(list(net.arcgis_query("https://example.test/layer", "1=1", page_size=2))) == 2


# --- sources ------------------------------------------------------------------------------
def test_overpass_timeout_remark_is_a_failure():
    with pytest.raises(RuntimeError, match="partial"):
        retail.overpass_elements({"remark": "runtime error: Query timed out in \"query\" at line 3", "elements": []})
    assert retail.overpass_elements({"elements": [{"id": 1}]}) == [{"id": 1}]


def test_boem_missing_past_year_fails_but_current_year_is_tolerated(monkeypatch):
    def missing(url, **kw):
        raise net.NotAvailable(url)

    monkeypatch.setattr(gom, "fetch", missing)
    today = gom.dt.date(2026, 3, 1)
    assert gom.production_zip(2026, today=today) is None
    with pytest.raises(net.NotAvailable):
        gom.production_zip(2019, today=today)


@pytest.mark.parametrize(
    "url,ok",
    [
        ("https://www.nhc.noaa.gov/storm_graphics/api/AL052026_TRACK_latest.kmz", True),
        ("https://nhc.noaa.gov/x.kmz", True),
        ("http://www.nhc.noaa.gov/x.kmz", False),
        ("https://nhc.noaa.gov.evil.example/x.kmz", False),
        ("https://169.254.169.254/latest/meta-data", False),
        (None, False),
    ],
)
def test_nhc_graphic_url_allowlist(url, ok):
    assert storms_live.nhc_url(url) is ok


# --- build --------------------------------------------------------------------------------
def _result(key: str, n: int) -> SourceResult:
    r = SourceResult(key=key, title="t", publisher="p", url="https://example.test", license="l")
    r.extra = {"items": list(range(n))}
    return r


def test_shrink_check_rejects_a_collapsed_refresh():
    with pytest.raises(RuntimeError, match="refusing"):
        build.check_not_shrunk(_result("osm", 10), (_result("osm", 1000), "2026-01-01"))


def test_shrink_check_allows_normal_change_and_exempt_sources():
    build.check_not_shrunk(_result("osm", 900), (_result("osm", 1000), "2026-01-01"))
    build.check_not_shrunk(_result("osm", 5), None)
    build.check_not_shrunk(_result("nhc_live", 0), (_result("nhc_live", 3), "2026-01-01"))


def test_failed_source_without_snapshot_is_reported_missing(tmp_path, monkeypatch):
    class Broken:
        @staticmethod
        def build():
            raise RuntimeError("upstream down")

    monkeypatch.setattr(build, "SOURCES", {"boem": Broken})
    monkeypatch.setattr(build, "SNAPSHOTS", tmp_path / "snapshots")
    rc = build.main(["--out", str(tmp_path / "out")])
    manifest = json.loads((tmp_path / "out" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["missing"] == ["boem"]
    assert rc == 1
