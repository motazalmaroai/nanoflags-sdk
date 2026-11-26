"""Shadow evaluation of drafts (migration 0179): the draft of a change waiting for approval is evaluated next to the
live bundle for a sample of evaluations; only counters leave the SDK; the shadow bundle is never applied.
Mirrors packages/sdk/test/shadow.test.ts."""

from __future__ import annotations

import copy
import json
import time
from typing import Any, Dict, List, Optional

import pytest
from conftest import ENV_ID, FakeEdge, make_bundle, wait_for
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from nanoflags import EventsOptions, NanoFlags, NanoFlagsError, ShadowOptions, VerifyOptions
from nanoflags.shadow import (
    MAX_SHADOW_COUNT,
    MAX_SHADOW_FLAGS,
    MAX_SHADOW_PAIRS,
    ShadowCounters,
    changed_flags,
    parse_shadow_header,
    repr_value,
    stable_stringify,
)

SESSION = "6f1c2a4e-8b1d-4c3e-9f00-1234567890ab"
DRAFT = "0123456789abcdef0123456789abcdef"
OTHER_ENV = "6f0c7c1e-0000-4000-8000-000000000999"


def marker(**over: Any) -> Dict[str, Any]:
    return {"sessionId": SESSION, "checksum": DRAFT, "environmentId": ENV_ID, "baseRevision": 3, **over}


def live_bundle(revision: int = 3) -> Dict[str, Any]:
    return make_bundle(revision, {
        "checkout-v2": {"type": "boolean", "enabled": True, "default": False, "off": False, "rules": [
            {"id": "staff", "match": "all", "conditions": [{"attribute": "", "op": "segment", "value": "staff"}], "serve": {"type": "fixed", "value": True}},
            {"id": "us", "match": "all", "conditions": [{"attribute": "signedIn", "op": "eq", "value": True}, {"attribute": "region", "op": "eq", "value": "US"}], "serve": {"type": "fixed", "value": True}},
        ]},
        "search-ranking": {"type": "string", "enabled": True, "default": "relevance-v3", "off": "relevance-v2", "rules": []},
        "max-items": {"type": "number", "enabled": True, "default": 10, "off": 0, "rules": []},
    }, segments={"staff": {"match": "all", "conditions": [{"attribute": "email", "op": "ends_with", "value": "@staff.test"}]}})


def draft_of(live: Dict[str, Any]) -> Dict[str, Any]:
    """The draft: checkout-v2 is on by default (live: off by default). Everything else as live."""
    d = copy.deepcopy(live)
    d["flags"]["checkout-v2"]["default"] = True
    return d


def client(edge: FakeEdge, **kw: Any) -> NanoFlags:
    opts: Dict[str, Any] = dict(
        base_url=edge.base_url,
        streaming=False,
        verify=VerifyOptions(public_keys=[edge.jwk], require=True),
        events=EventsOptions(sample_rate=0, flush_interval=60),
        service="checkout-service",
        service_version="3.1.0",
        shadow=ShadowOptions(sample_rate=1),
    )
    opts.update(kw)
    key = opts.pop("sdk_key", "nf_srv_test")
    return NanoFlags(key, **opts)


def ready(c: NanoFlags) -> bool:
    """Waits for the first load and for the shadow fetch it triggered (it runs right after, on the sync thread)."""
    ok = c.wait_until_ready(5)
    with c._sync_mutex:
        pass
    return ok


def shadow_of(body: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    return body.get("shadow")


@pytest.fixture
def shadow_edge(edge: FakeEdge) -> FakeEdge:
    live = live_bundle()
    edge.set_bundle(live)
    edge.set_shadow(draft_of(live), marker())
    return edge


def errors_of(c: NanoFlags) -> List[NanoFlagsError]:
    errors: List[NanoFlagsError] = []
    c.on_error(errors.append)
    return errors


# ---------------------------------------------------------------------------------------------------- client


def test_evaluates_the_draft_never_applies_it_and_reports_only_counters(shadow_edge: FakeEdge) -> None:
    errors: List[NanoFlagsError] = []
    with client(shadow_edge, on_error=errors.append) as c:
        assert ready(c)
        assert shadow_edge.count("/v1/shadow") == 1
        # Zero behaviour change: the app always gets the live value.
        for i in range(30):
            assert c.bool_variation("checkout-v2", True, {"region": "DE", "email": f"person{i}@example.test", "userId": f"u{i}"}) is False
        for _ in range(10):
            assert c.bool_variation("checkout-v2", False, {"signedIn": True, "region": "US", "key": "k"}) is True
        assert c.string_variation("search-ranking", "fb") == "relevance-v3"  # unchanged flag: not shadowed
        assert c.revision == 3
        assert errors == []

        c.flush()
        body = shadow_edge.events[-1]
        assert body["sdk"] == "python/0.3.2" and body["service"] == "checkout-service"
        assert shadow_of(body) == {
            "sessionId": SESSION, "checksum": DRAFT, "version": "3.1.0",
            "flags": [{"flag": "checkout-v2", "samples": 40, "flips": 30, "pairs": [{"live": "false", "shadow": "true", "count": 30}], "rules": {"default": 30, "1": 10}}],
        }
        # No context, attribute or identifier leaves the SDK with the shadow report.
        text = json.dumps(shadow_of(body))
        for s in ["example.test", "person", "u1", "region", "DE", "signedIn", "US", "userId"]:
            assert s not in text
        # Counters restart after a report: the next flush carries no shadow member.
        c.flush()
        assert shadow_of(shadow_edge.events[-1]) is None


def test_samples_at_the_configured_rate_and_only_the_flags_the_draft_changes(shadow_edge: FakeEdge) -> None:
    calls = {"n": 0}

    def rnd() -> float:  # 0, .25, .5, .75 …
        v = (calls["n"] % 4) / 4
        calls["n"] += 1
        return v

    with client(shadow_edge, shadow=ShadowOptions(sample_rate=0.25, random=rnd)) as c:
        ready(c)
        for _ in range(100):
            c.bool_variation("checkout-v2", False, {"region": "DE"})
        for _ in range(50):
            c.number_variation("max-items", 0)
        assert calls["n"] == 100  # unchanged flags never draw
        c.flush()
        assert shadow_of(shadow_edge.events[-1])["flags"] == [{"flag": "checkout-v2", "samples": 25, "flips": 25, "pairs": [{"live": "false", "shadow": "true", "count": 25}], "rules": {"default": 25}}]


def test_a_tampered_shadow_bundle_is_ignored(edge: FakeEdge) -> None:
    live = live_bundle()
    edge.set_bundle(live)
    edge.set_shadow(draft_of(live), marker(), tamper=lambda t: t.replace('"default": true', '"default": "evil"', 1))
    errors: List[NanoFlagsError] = []
    with client(edge, on_error=errors.append) as c:
        ready(c)
        for _ in range(5):
            assert c.bool_variation("checkout-v2", True, {"region": "DE"}) is False
        c.flush()
        assert shadow_of(edge.events[-1]) is None
        assert [e.code for e in errors] == ["shadow"]
        assert c.revision == 3


@pytest.mark.parametrize(
    "opts",
    [
        pytest.param({"key": Ed25519PrivateKey.generate()}, id="signed by an unknown key"),
        pytest.param({"domain": "bundle"}, id="signed as a normal bundle"),
        pytest.param({"marker": marker(sessionId="11111111-2222-4333-8444-555555555555"), "session_id": SESSION}, id="marker of another session"),
        pytest.param({"marker": marker(environmentId=OTHER_ENV)}, id="marker of another environment"),
        pytest.param({"environment_id": OTHER_ENV}, id="signed for another environment"),
    ],
)
def test_rejects_a_shadow_bundle(edge: FakeEdge, opts: Dict[str, Any]) -> None:
    live = live_bundle()
    edge.set_bundle(live)
    m = opts.pop("marker", marker())
    edge.set_shadow(draft_of(live), m, **opts)
    errors: List[NanoFlagsError] = []
    with client(edge, on_error=errors.append) as c:
        ready(c)
        c.bool_variation("checkout-v2", True, {"region": "DE"})
        c.flush()
        assert shadow_of(edge.events[-1]) is None
        assert [e.code for e in errors] == ["shadow"]


def test_a_shadow_bundle_is_never_applied_as_configuration(edge: FakeEdge, tmp_path: Any) -> None:
    live = live_bundle()
    edge.set_bundle(live)
    draft = {**draft_of(live_bundle(4)), "shadow": marker()}
    errors: List[NanoFlagsError] = []
    with client(edge, on_error=errors.append, live_url=edge.live_url, streaming=True) as c:
        ready(c)
        assert c.revision == 3
        # An attacker (or a bug) serves the shadow bundle on /v1/bundle with a valid bundle signature over its bytes.
        edge.set_bundle(draft)
        c.refresh()
        assert c.revision == 3 and c.bool_variation("checkout-v2", True, {"region": "DE"}) is False
        assert errors and errors[-1].code == "invalid_bundle"
        # Pushed over the live socket, validly signed: refused as well.
        assert wait_for(lambda: c.transport == "live")
        errors.clear()
        edge.push(draft)
        assert wait_for(lambda: any(e.code == "invalid_bundle" for e in errors))
        assert c.revision == 3
    # Without verification as well.
    with client(edge, verify=False) as c2:
        assert c2.wait_until_ready(5) is False
        assert c2.status == "not-ready" and c2.bool_variation("checkout-v2", False) is False
    # Nor as a bootstrap.
    boot_errors: List[NanoFlagsError] = []
    c3 = client(edge, verify=False, bootstrap=draft, on_error=boot_errors.append, start=False)
    assert c3.revision is None
    c3.close()
    # Nor restored from the store.
    from nanoflags import FileStore

    path = tmp_path / "cache.json"
    edge.set_bundle(live)
    with client(edge, verify=False, cache_path=str(path)) as c4:
        ready(c4)
    saved = json.loads(path.read_text())
    saved["bundle"] = draft
    path.write_text(json.dumps(saved))
    with client(edge, verify=False, store=FileStore(str(path)), start=False) as c5:
        c5._restore()
        assert c5.revision is None


def test_withdrawn_when_the_edge_stops_announcing_it_pending_counters_first(shadow_edge: FakeEdge) -> None:
    with client(shadow_edge) as c:
        ready(c)
        c.bool_variation("checkout-v2", False, {"region": "DE"})
        shadow_edge.shadow_header = None
        c.refresh()  # 304 without the header
        assert shadow_of(shadow_edge.events[-1])["flags"][0]["samples"] == 1
        before = len(shadow_edge.events)
        c.bool_variation("checkout-v2", False, {"region": "DE"})
        c.flush()
        assert len(shadow_edge.events) == before + 1
        assert shadow_of(shadow_edge.events[-1]) is None


def test_withdrawn_when_v1_shadow_is_404(shadow_edge: FakeEdge) -> None:
    with client(shadow_edge) as c:
        ready(c)
        c.bool_variation("checkout-v2", False, {"region": "DE"})
        # A new announcement, but the session is already gone.
        shadow_edge.shadow_header = f"{SESSION}.{'e' * 32}"
        shadow_edge.shadow_answer = None
        c.refresh()
        assert shadow_of(shadow_edge.events[-1])["checksum"] == DRAFT
        c.bool_variation("checkout-v2", False, {"region": "DE"})
        c.flush()
        assert shadow_of(shadow_edge.events[-1]) is None


def test_a_new_draft_replaces_the_session_old_counters_first(shadow_edge: FakeEdge) -> None:
    nxt = "f" * 32
    with client(shadow_edge) as c:
        ready(c)
        c.bool_variation("checkout-v2", False, {"region": "DE"})
        shadow_edge.set_shadow(draft_of(live_bundle()), marker(checksum=nxt))
        c.refresh()
        first = shadow_of(shadow_edge.events[-1])
        assert first["checksum"] == DRAFT and first["flags"][0]["samples"] == 1
        c.bool_variation("checkout-v2", False, {"region": "DE"})
        c.flush()
        second = shadow_of(shadow_edge.events[-1])
        assert second["checksum"] == nxt and second["flags"][0]["samples"] == 1


def test_a_failed_fetch_is_not_retried_for_the_same_announcement_within_a_minute(shadow_edge: FakeEdge) -> None:
    good = shadow_edge.shadow_answer
    shadow_edge.shadow_answer = (500, b"{}", {})
    with client(shadow_edge) as c:
        ready(c)
        assert shadow_edge.count("/v1/shadow") == 1
        shadow_edge.shadow_answer = good
        c.refresh()
        c.refresh()
        assert shadow_edge.count("/v1/shadow") == 1
        c._shadow_fetch["at"] -= 61  # type: ignore[index]
        c.refresh()
        assert shadow_edge.count("/v1/shadow") == 2
        c.bool_variation("checkout-v2", False, {"region": "DE"})
        c.flush()
        assert shadow_of(shadow_edge.events[-1])["flags"][0]["samples"] == 1


def test_counters_ride_with_timer_flushes_at_most_once_a_minute(shadow_edge: FakeEdge) -> None:
    with client(shadow_edge, events=EventsOptions(sample_rate=1, flush_interval=0.02)) as c:
        ready(c)
        c.bool_variation("checkout-v2", False, {"region": "DE"})
        assert wait_for(lambda: len(shadow_edge.events) > 0)
        time.sleep(0.1)
        assert all(shadow_of(b) is None for b in list(shadow_edge.events))
        c.flush()
        assert shadow_of(shadow_edge.events[-1])["flags"][0]["samples"] == 1


def test_close_sends_pending_counters(shadow_edge: FakeEdge) -> None:
    c = client(shadow_edge)
    ready(c)
    c.bool_variation("checkout-v2", False, {"region": "DE"})
    c.close()
    assert shadow_of(shadow_edge.events[-1])["flags"][0]["samples"] == 1
    # After close nothing is fetched or counted any more.
    c.bool_variation("checkout-v2", False, {"region": "DE"})
    assert shadow_edge.count("/v1/shadow") == 1


@pytest.mark.parametrize("opts", [{"shadow": False}, {"events": False}, {"shadow": ShadowOptions(enabled=False)}], ids=["shadow=False", "events=False", "enabled=False"])
def test_opt_out_never_fetches_the_shadow_bundle(shadow_edge: FakeEdge, opts: Dict[str, Any]) -> None:
    with client(shadow_edge, **opts) as c:
        ready(c)
        c.bool_variation("checkout-v2", False, {"region": "DE"})
        c.flush()
        assert shadow_edge.count("/v1/shadow") == 0
        assert all(shadow_of(b) is None for b in shadow_edge.events)


def test_without_verification_the_shadow_bundle_is_still_checked_with_v1_keys(shadow_edge: FakeEdge) -> None:
    with client(shadow_edge, verify=False) as c:
        ready(c)
        c.bool_variation("checkout-v2", False, {"region": "DE"})
        c.flush()
        assert shadow_edge.count("/v1/keys") == 1
        assert shadow_of(shadow_edge.events[-1])["flags"][0]["samples"] == 1
        # The SDK key is never sent to the public keys endpoint.
        keys_req = [r for r in shadow_edge.requests if r["path"] == "/v1/keys"][-1]
        assert "Authorization" not in keys_req["headers"]


def test_the_apps_own_fallback_never_leaves_the_sdk(edge: FakeEdge) -> None:
    live = live_bundle()
    edge.set_bundle(live)
    draft = draft_of(live)
    draft["flags"]["brand-new"] = {"type": "string", "enabled": True, "default": "x", "off": "off", "rules": []}
    draft["flags"]["search-ranking"]["default"] = 42  # wrong type for string_variation()
    edge.set_shadow(draft, marker())
    with client(edge) as c:
        ready(c)
        assert c.string_variation("brand-new", "alice@example.test") == "alice@example.test"
        assert c.string_variation("search-ranking", "bob@example.test") == "relevance-v3"
        c.flush()
        report = shadow_of(edge.events[-1])
        assert "example.test" not in json.dumps(report)
        flags = {f["flag"]: f for f in report["flags"]}
        assert flags["brand-new"]["pairs"] == [{"live": "<fallback>", "shadow": '"x"', "count": 1}]
        assert flags["search-ranking"]["pairs"] == [{"live": '"relevance-v3"', "shadow": "<fallback>", "count": 1}]


def test_test_sessions_are_never_shadowed(shadow_edge: FakeEdge) -> None:
    shadow_edge.sessions["nf_ts_aaaaaaaa"] = {"id": "8d3c1a52-0d6f-4c3e-9d65-0e8f0e6a1b11", "bundle": live_bundle(3), "context": {"region": "DE"}, "expires_at": "2099-01-01T00:00:00Z"}
    with client(shadow_edge) as c:
        ready(c)
        s = c.session("nf_ts_aaaaaaaa")
        assert s.active
        for _ in range(5):
            assert s.bool_variation("checkout-v2", True) is False
        c.flush()
        assert shadow_of(shadow_edge.events[-1]) is None
        # An unknown session evaluates like the client, and is shadowed like the client.
        c.session("nf_ts_unknown0").bool_variation("checkout-v2", True, {"region": "DE"})
        c.flush()
        assert shadow_of(shadow_edge.events[-1])["flags"][0]["samples"] == 1


def test_browser_keys_work_the_same_way(shadow_edge: FakeEdge) -> None:
    with client(shadow_edge, sdk_key="nf_pub_test") as c:
        ready(c)
        assert c.bool_variation("checkout-v2", True, {"region": "DE"}) is False
        c.flush()
        assert shadow_of(shadow_edge.events[-1])["flags"][0]["flips"] == 1


def test_a_failing_shadow_evaluation_never_affects_the_app(shadow_edge: FakeEdge) -> None:
    def boom() -> float:
        raise RuntimeError("random source failed")

    with client(shadow_edge, shadow=ShadowOptions(sample_rate=1, random=boom)) as c:
        ready(c)
        assert c.bool_variation("checkout-v2", True, {"region": "DE"}) is False
        assert c.bool_variation_detail("checkout-v2", True, {"region": "DE"}).reason == "default"


# ---------------------------------------------------------------------------------------------------- helpers


def test_parses_the_announcement_header() -> None:
    assert parse_shadow_header(f"{SESSION}.{DRAFT}") == {"sessionId": SESSION, "checksum": DRAFT}
    assert parse_shadow_header(f" {SESSION.upper()}.{DRAFT.upper()} ") == {"sessionId": SESSION, "checksum": DRAFT}
    for bad in [None, "", "x.y", SESSION, f"{SESSION}.{DRAFT}x", f"not-a-uuid-not-a-uuid-not-a-uuid-xxx.{DRAFT}"]:
        assert parse_shadow_header(bad) is None


def test_changed_flags_configuration_differences_and_changed_segments_whatever_the_key_order() -> None:
    live = live_bundle()
    assert changed_flags(live, live) == set()
    reordered = json.loads(json.dumps(live, sort_keys=True))
    reordered["flags"] = dict(reversed(list(reordered["flags"].items())))
    assert changed_flags(live, reordered) == set()
    assert changed_flags(live, draft_of(live)) == {"checkout-v2"}
    seg = copy.deepcopy(live)
    seg["segments"]["staff"]["conditions"][0]["value"] = "@example.test"
    assert changed_flags(live, seg) == {"checkout-v2"}  # it references `staff`
    added = copy.deepcopy(live)
    added["flags"]["brand_new"] = {"type": "boolean", "enabled": True, "default": True, "off": False, "rules": []}
    assert changed_flags(live, added) == {"brand_new"}


def test_changed_flags_nested_and_removed_segments_and_cycles() -> None:
    def flag(op: str, value: str) -> Dict[str, Any]:
        return {"type": "boolean", "enabled": True, "default": False, "off": False, "rules": [{"id": "r", "match": "all", "conditions": [{"attribute": "", "op": op, "value": value}], "serve": {"type": "fixed", "value": True}}]}

    g = {"type": "boolean", "enabled": True, "default": False, "off": False, "rules": []}

    def nested(v: int) -> Dict[str, Any]:
        return {"schema": 1, "project": "p", "environment": "e", "revision": 1, "flags": {"f": flag("segment", "a"), "g": g},
                "segments": {"a": {"match": "all", "conditions": [{"attribute": "", "op": "segment", "value": "b"}]}, "b": {"match": "all", "conditions": [{"attribute": "x", "op": "eq", "value": v}]}}}

    assert changed_flags(nested(1), nested(2)) == {"f"}
    assert changed_flags(nested(1), nested(1)) == set()
    with_c = {**nested(1), "flags": {"f": flag("not_segment", "a"), "g": g}, "segments": {"a": {"match": "any", "conditions": [{"attribute": "", "op": "segment", "value": "c"}]}, "c": {"match": "all", "conditions": []}}}
    without_c = {**with_c, "segments": {"a": with_c["segments"]["a"]}}
    assert changed_flags(with_c, without_c) == {"f"}

    def cyc(extra: bool) -> Dict[str, Any]:
        b_conds: List[Dict[str, Any]] = [{"attribute": "", "op": "segment", "value": "a"}] + ([{"attribute": "x", "op": "eq", "value": 1}] if extra else [])
        return {**nested(1), "segments": {"a": {"match": "all", "conditions": [{"attribute": "", "op": "segment", "value": "b"}]}, "b": {"match": "all", "conditions": b_conds}}}

    assert changed_flags(cyc(False), cyc(True)) == {"f"}  # a cycle terminates


def test_flips_are_decided_independently_of_object_key_order() -> None:
    c = ShadowCounters(SESSION, DRAFT)
    c.add("cfg", {"a": 1, "b": 2}, {"b": 2, "a": 1}, None)
    c.add("cfg", {"a": 1, "b": {"e": 1, "c": 2}}, {"b": {"c": 2, "e": 1}, "a": 1}, None)
    f = c.drain(None)["flags"][0]  # type: ignore[index]
    assert (f["samples"], f["flips"], f["pairs"]) == (2, 0, [])
    assert repr_value({"b": 2, "a": 1}) == '{"a":1,"b":2}'


def test_values_json_text_up_to_100_characters_longer_ones_hashed() -> None:
    assert repr_value(True) == "true"
    assert repr_value("blue") == '"blue"'
    assert repr_value({"a": 1}) == '{"a":1}'
    long = repr_value("x" * 200)
    assert long.startswith("#") and len(long) == 9 and all(ch in "0123456789abcdef" for ch in long[1:])
    assert repr_value(None) == "null"
    # Same hash as the JavaScript SDK (murmur3 of the JSON text, NFC, as 8 hex digits).
    assert long == "#6685751d"
    assert repr_value({"k": "é" * 120}) == "#c3e3b467"
    # The JSON text is the one JavaScript produces: same numbers, same escapes, keys sorted by UTF-16 code units.
    assert repr_value(1.0) == "1" and repr_value(1e21) == "1e+21" and repr_value(0.1) == "0.1"
    assert stable_stringify({"￿": 1, "\U0001f600": 2}) == '{"\U0001f600":2,"￿":1}'
    assert repr_value("é" * 98) == '"' + "é" * 98 + '"'  # 100 UTF-16 code units: kept


def test_counters_are_bounded() -> None:
    c = ShadowCounters(SESSION, DRAFT)
    for i in range(MAX_SHADOW_FLAGS + 20):
        c.add(f"f{i}", False, True, 0)
    assert c.size == MAX_SHADOW_FLAGS
    p = ShadowCounters(SESSION, DRAFT)
    for i in range(50):
        p.add("color", "a", f"b{i}", i)
    report = p.drain(None)
    assert report is not None and "version" not in report
    r = report["flags"][0]
    assert r["samples"] == 50 and r["flips"] == 50
    assert len(r["pairs"]) == MAX_SHADOW_PAIRS
    assert r["pairs"][-1] == {"live": "*", "shadow": "*", "count": 50 - (MAX_SHADOW_PAIRS - 1)}
    assert sum(x["count"] for x in r["pairs"]) == 50
    assert len(r["rules"]) == 50
    assert p.drain(None) is None  # drained


def test_counters_stay_within_what_the_edge_accepts() -> None:
    c = ShadowCounters(SESSION, DRAFT)
    c.add("x" * 64, False, True, 0)  # the edge refuses flag keys over 63 characters (and the whole report with them)
    c.add("", False, True, 0)
    assert c.size == 0
    c.add("big", False, True, 0)
    c._flags["big"].samples = MAX_SHADOW_COUNT  # type: ignore[attr-defined]
    c.add("big", False, True, 0)
    f = c.drain("v")["flags"][0]  # type: ignore[index]
    assert f["samples"] == MAX_SHADOW_COUNT and f["flips"] == 1
    c.add("r", False, False, 10_000)  # out-of-range rule indexes count as "default"
    assert c.drain(None)["flags"][0]["rules"] == {"default": 1}  # type: ignore[index]


def test_service_version_is_trimmed_and_bounded(edge: FakeEdge) -> None:
    with client(edge, service_version="  " + "9" * 50 + " ", start=False) as c:
        assert c._service_version == "9" * 40
    with client(edge, service_version="   ", start=False) as c:
        assert c._service_version is None


def test_a_shadow_bundle_is_not_used_before_a_live_bundle_verified(edge: FakeEdge) -> None:
    """Regression: the shadow bundle announced with a live answer that failed verification (nothing pinned yet) is not
    used, even though it is validly signed: it may be signed for another environment. Not fetching it then is not an
    attempt: the next (verified) announcement fetches and checks it at once."""
    live = live_bundle()
    edge.set_bundle(live)
    good = edge.signature
    with edge.lock:
        edge.signature = edge.sign(edge.text + " ", edge.revision, edge.checksum)  # does not verify
    edge.set_shadow(draft_of(live), marker(environmentId=OTHER_ENV), environment_id=OTHER_ENV)
    errors: List[NanoFlagsError] = []
    with client(edge, on_error=errors.append) as c:
        deadline = time.time() + 5
        while not errors and time.time() < deadline:
            time.sleep(0.01)
        with c._sync_mutex:
            pass
        assert [e.code for e in errors] == ["signature"]
        assert edge.count("/v1/shadow") == 0
        with edge.lock:
            edge.signature = good
        c.refresh()
        assert c.revision == 3
        assert edge.count("/v1/shadow") == 1  # retried at once, not after the retry interval
        c.bool_variation("checkout-v2", True, {"region": "DE"})
        c.flush()
        assert shadow_of(edge.events[-1]) is None
        assert [e.code for e in errors] == ["signature", "shadow"]
