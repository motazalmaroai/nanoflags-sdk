from __future__ import annotations

import json
import threading
import time
from typing import Any, List

import pytest
from conftest import ENV_ID, FakeEdge, make_bundle, wait_for
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from nanoflags import CLOSE_ENVIRONMENT_DELETED, EventsOptions, FileStore, NanoFlags, NanoFlagsError, UpdateEvent, VerifyOptions
from nanoflags._http import HttpResponse, _Headers


def client(edge: FakeEdge, **kw: Any) -> NanoFlags:
    opts: dict = dict(base_url=edge.base_url, live_url=edge.live_url, verify=VerifyOptions(public_keys=[edge.jwk], require=True), events=False, poll_interval=30)
    opts.update(kw)
    return NanoFlags("nf_srv_test", **opts)


def test_initial_load_variations_and_details(edge: FakeEdge) -> None:
    with client(edge, streaming=False) as c:
        assert c.wait_until_ready(5) is True
        assert c.status == "ready" and c.revision == 1 and c.transport == "poll"
        assert c.bool_variation("new-checkout", False, {"key": "u1", "plan": "beta"}) is True
        assert c.string_variation("accent", "x") == "blue"
        assert c.number_variation("limit", 1) == 10
        assert c.json_variation("layout", {}) == {"cols": 3}
        assert c.string_variation("disabled", "x") == "off"
        # Type mismatch and unknown flags serve the default; nothing raises.
        assert c.bool_variation("accent", True) is True
        assert c.number_variation("new-checkout", 7) == 7
        assert c.string_variation("missing", "fb") == "fb"
        d = c.bool_variation_detail("new-checkout", False, {"key": "u1", "plan": "beta"})
        assert (d.reason, d.rule_index, d.rule_id, d.revision) == ("rule_match", 0, "beta", 1)
        d = c.string_variation_detail("accent", "x")
        assert d.reason == "default"
        d = c.bool_variation_detail("accent", False)
        assert d.reason == "error" and "does not match the requested type" in (d.error or "")
        assert c.string_variation_detail("missing", "fb").reason == "flag_not_found"
        r = c.evaluate("new-checkout", None, {"key": "user-7"})
        assert r.in_rollout is not None and r.bucket is not None
        assert c.all_flags({"key": "u1", "plan": "beta"}) == {"new-checkout": True, "accent": "blue", "limit": 10, "layout": {"cols": 3}, "disabled": "off"}
        # The bundle request carries the key as a header.
        assert any(r["path"] == "/v1/bundle" and r["headers"].get("Authorization") == "Bearer nf_srv_test" for r in edge.requests)


def test_etag_revalidation_and_refresh(edge: FakeEdge) -> None:
    with client(edge, streaming=False) as c:
        c.wait_until_ready(5)
        c.refresh()
        assert c.status == "ready"
        assert edge.requests[-1]["headers"].get("If-None-Match") == f'"{edge.checksum}-server"'
        updates: List[UpdateEvent] = []
        c.on_change(updates.append)
        edge.set_bundle(make_bundle(2))
        c.refresh()
        assert c.revision == 2 and updates[-1].revision == 2 and updates[-1].previous_revision == 1 and updates[-1].transport == "poll"


def test_tampered_bundle_is_rejected_and_last_good_kept(edge: FakeEdge) -> None:
    errors: List[NanoFlagsError] = []
    with client(edge, streaming=False, on_error=errors.append) as c:
        c.wait_until_ready(5)
        edge.set_bundle(make_bundle(2))
        edge.tamper = True
        c.refresh()
        assert c.revision == 1 and c.string_variation("accent", "x") == "blue"
        assert errors and errors[-1].code == "signature" and "does not verify" in str(errors[-1])


def test_unsigned_bundle_refused_with_require_but_accepted_without(edge: FakeEdge) -> None:
    edge.signed = False
    errors: List[NanoFlagsError] = []
    with client(edge, streaming=False, on_error=errors.append) as c:
        assert c.wait_until_ready(5) is False
        assert c.status == "not-ready" and errors[-1].code == "signature"
        assert c.bool_variation("new-checkout", True) is True  # fallback, never raises
    with client(edge, streaming=False, verify=VerifyOptions(public_keys=[edge.jwk], require=False)) as c:
        assert c.wait_until_ready(5) is True


def test_bundle_signed_by_another_key_is_rejected(edge: FakeEdge) -> None:
    other = Ed25519PrivateKey.generate()
    edge.set_bundle(make_bundle(1))
    edge.signature = edge.sign(edge.text, edge.revision, edge.checksum, other)
    errors: List[NanoFlagsError] = []
    with client(edge, streaming=False, on_error=errors.append) as c:
        assert c.wait_until_ready(5) is False
        assert errors[-1].code == "signature"


def test_keys_fetched_from_edge_when_configured(edge: FakeEdge) -> None:
    with client(edge, streaming=False, verify=VerifyOptions(public_keys="fetch", require=True)) as c:
        assert c.wait_until_ready(5) is True
        assert any(r["path"] == "/v1/keys" and "Authorization" not in r["headers"] for r in edge.requests)


def test_official_edge_verifies_by_default_with_embedded_keys() -> None:
    """Default settings against https://edge.nanoflags.io: a bundle not signed by the production key is refused,
    and so is an unsigned one."""
    fake = FakeEdge()
    try:
        calls: List[str] = []

        def http(method: str, url: str, headers: dict, body: Any, timeout: float) -> HttpResponse:
            calls.append(url)
            if url.endswith("/v1/keys"):
                return HttpResponse(200, _Headers({}), json.dumps({"keys": [{"kty": "OKP", "crv": "Ed25519", "x": "wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U", "kid": "k1"}]}).encode())
            body_text = f'{{"revision":{fake.revision},"checksum":"{fake.checksum}","bundle":{fake.text}}}'
            return HttpResponse(200, _Headers({"X-NanoFlags-Signed": "true", "X-NanoFlags-Signature": fake.signature, "X-NanoFlags-Key-Id": "k1", "X-NanoFlags-Environment-Id": ENV_ID}), body_text.encode())

        errors: List[NanoFlagsError] = []
        c = NanoFlags("nf_srv_x", http=http, streaming=False, events=False, on_error=errors.append)
        assert c.wait_until_ready(5) is False
        assert errors and errors[-1].code == "signature"
        c.close()

        def unsigned(method: str, url: str, headers: dict, body: Any, timeout: float) -> HttpResponse:
            return HttpResponse(200, _Headers({"X-NanoFlags-Signed": "false"}), f'{{"revision":1,"checksum":"c","bundle":{fake.text}}}'.encode())

        errors.clear()
        c = NanoFlags("nf_srv_x", http=unsigned, streaming=False, events=False, on_error=errors.append)
        assert c.wait_until_ready(5) is False and "not signed" in str(errors[-1])
        c.close()
        # Explicitly off: accepted.
        c = NanoFlags("nf_srv_x", http=unsigned, streaming=False, events=False, verify=False)
        assert c.wait_until_ready(5) is True
        c.close()
    finally:
        fake.shutdown()


def test_newer_engine_is_refused(edge: FakeEdge) -> None:
    errors: List[NanoFlagsError] = []
    with client(edge, streaming=False, on_error=errors.append) as c:
        c.wait_until_ready(5)
        edge.set_bundle(make_bundle(2, engine=99))
        c.refresh()
        assert c.revision == 1 and c.status == "ready"
        assert errors[-1].code == "engine"


def test_live_push_hello_update_and_tamper(edge: FakeEdge) -> None:
    updates: List[UpdateEvent] = []
    errors: List[NanoFlagsError] = []
    with client(edge, on_change=updates.append, on_error=errors.append) as c:
        assert c.wait_until_ready(5)
        assert wait_for(lambda: c.transport == "live")
        commit = time.time() * 1000 - 25
        edge.push(make_bundle(2, flags={"accent": {"type": "string", "enabled": True, "default": "orange", "off": "grey", "rules": []}}), committed_at=commit)
        assert wait_for(lambda: c.revision == 2)
        assert c.string_variation("accent", "x") == "orange"
        u = updates[-1]
        assert u.transport == "live" and u.revision == 2 and u.latency_ms is not None and u.latency_ms >= 25
        # A tampered push changes nothing.
        edge.push(make_bundle(3), tamper=True)
        assert wait_for(lambda: any(e.code == "signature" for e in errors))
        time.sleep(0.2)
        # ...but the verified request path then fetches r3 (the untampered bundle the edge really serves).
        assert wait_for(lambda: c.revision == 3)
        assert c.string_variation("accent", "x") == "blue"


def test_live_push_signed_by_foreign_key_rejected(edge: FakeEdge) -> None:
    errors: List[NanoFlagsError] = []
    with client(edge, on_error=errors.append, poll_interval=0) as c:
        assert c.wait_until_ready(5) and wait_for(lambda: c.transport == "live")
        edge.push(make_bundle(5), sign_key=Ed25519PrivateKey.generate())
        assert wait_for(lambda: any("Pushed bundle r5 was rejected" in str(e) for e in errors))
        assert c.revision in (1, 5)  # r5 may then arrive through the verified HTTP path
        assert c.string_variation("accent", "x") == "blue"


def test_environment_deleted_close_code_stops_reconnects(edge: FakeEdge) -> None:
    errors: List[NanoFlagsError] = []
    with client(edge, on_error=errors.append) as c:
        assert c.wait_until_ready(5) and wait_for(lambda: c.transport == "live")
        connects = edge.ws_connects
        edge.close_sockets(CLOSE_ENVIRONMENT_DELETED, "environment deleted")
        assert wait_for(lambda: any(e.code == "environment_deleted" for e in errors))
        assert c.status == "stale" and c.transport == "poll"
        time.sleep(1.5)
        assert edge.ws_connects == connects  # no reconnect
        assert c.string_variation("accent", "x") == "blue"  # last bundle kept


def test_live_reconnects_after_drop(edge: FakeEdge) -> None:
    with client(edge) as c:
        assert c.wait_until_ready(5) and wait_for(lambda: c.transport == "live")
        n = edge.ws_connects
        edge.close_sockets(1011, "restart")
        assert wait_for(lambda: edge.ws_connects > n and c.transport == "live", 8)


def test_file_cache_restore_and_tamper(edge: FakeEdge, tmp_path: Any) -> None:
    path = tmp_path / "flags.json"
    with client(edge, streaming=False, cache_path=str(path)) as c:
        assert c.wait_until_ready(5)
    saved = json.loads(path.read_text())
    assert saved["v"] == 1 and saved["sig"]["kid"] == "t1" and isinstance(saved["raw"], str)
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    edge.status_override = 503  # edge down: the cached copy is used, stale
    with client(edge, streaming=False, cache_path=str(path)) as c:
        assert c.wait_until_ready(5)
        assert c.status == "stale" and c.revision == 1 and c.string_variation("accent", "x") == "blue"
    # Tampered cache: refused.
    saved["raw"] = saved["raw"].replace('"default": "blue"', '"default": "red"')
    path.write_text(json.dumps(saved))
    errors: List[NanoFlagsError] = []
    with client(edge, streaming=False, cache_path=str(path), on_error=errors.append) as c:
        assert c.wait_until_ready(5) is False
        assert any("persisted bundle failed signature verification" in str(e) for e in errors)


def test_bootstrap_used_until_edge_answers(edge: FakeEdge) -> None:
    edge.status_override = 503
    b = make_bundle(0, flags={"accent": {"type": "string", "enabled": True, "default": "boot", "off": "x", "rules": []}})
    c = client(edge, streaming=False, bootstrap=b, start=False)
    assert c.status == "ready" and c.string_variation("accent", "x") == "boot"
    c.start()
    assert wait_for(lambda: c.status == "stale")  # the edge failed: the bootstrap stays in use
    assert c.string_variation("accent", "x") == "boot"
    edge.status_override = None
    c.refresh()
    assert c.string_variation("accent", "x") == "blue" and c.status == "ready"
    c.close()


def test_invalid_bootstrap_reported(edge: FakeEdge) -> None:
    errors: List[NanoFlagsError] = []
    with client(edge, streaming=False, bootstrap={"nope": 1}, on_error=errors.append) as c:
        c.wait_until_ready(5)
        assert any(e.code == "invalid_bundle" for e in errors)


def test_unauthorized_reported(edge: FakeEdge) -> None:
    edge.status_override = 401
    errors: List[NanoFlagsError] = []
    with client(edge, streaming=False, on_error=errors.append) as c:
        assert c.wait_until_ready(5) is False
        assert errors[-1].code == "unauthorized" and errors[-1].http_status == 401


def test_events_and_service_report(edge: FakeEdge) -> None:
    c = client(edge, streaming=False, events=EventsOptions(sample_rate=1.0, flush_interval=0.2, report_interval=0.2), service="py-test")
    c.wait_until_ready(5)
    c.bool_variation("new-checkout", False, {"key": "u1", "plan": "beta", "email": "secret@example.com"})
    assert wait_for(lambda: any(e["events"] for e in edge.events))
    batch = next(e for e in edge.events if e["events"])
    assert batch["service"] == "py-test" and batch["sdk"] == "python/0.1.0" and batch["revision"] == 1
    ev = batch["events"][0]
    assert ev["flagKey"] == "new-checkout" and ev["reason"] == "rule_match" and ev["ruleIndex"] == 0
    # Only names and types of attributes the rules use leave the process — never values.
    assert ev["context"] == {"plan": "string", "key": "string"}
    assert "secret" not in json.dumps(batch)
    c.close()


def test_test_session_override(edge: FakeEdge) -> None:
    pinned = make_bundle(9, flags={"accent": {"type": "string", "enabled": True, "default": "session", "off": "x", "rules": [
        {"id": "r", "match": "all", "conditions": [{"attribute": "plan", "op": "eq", "value": "pro"}], "serve": {"type": "fixed", "value": "session-pro"}}]}})
    edge.sessions["nf_ts_abc"] = {"id": "8d3c1a52-0d6f-4c3e-9d65-0e8f0e6a1b11", "checksum": "c", "source": "draft", "revision": 9, "context": {"plan": "pro"}, "expires_at": "2999-01-01T00:00:00Z", "bundle": pinned}
    with client(edge, streaming=False) as c:
        c.wait_until_ready(5)
        s = c.session("nf_ts_abc")
        assert s.active and s.revision == 9 and s.id
        assert s.string_variation("accent", "x") == "session-pro"
        assert s.string_variation("accent", "x", {"plan": "free"}) == "session"
        assert c.string_variation("accent", "x") == "blue"  # the client itself is untouched
        none = c.session("nf_ts_unknown")
        assert not none.active and none.string_variation("accent", "x") == "blue"
        assert not c.session(None).active


def test_thread_safety_under_concurrent_updates(edge: FakeEdge) -> None:
    with client(edge, streaming=False, events=EventsOptions(sample_rate=1.0, flush_interval=60)) as c:
        c.wait_until_ready(5)
        stop = threading.Event()
        bad: List[Any] = []

        def reader() -> None:
            while not stop.is_set():
                v = c.string_variation("accent", "x")
                if v not in ("blue", "green"):
                    bad.append(v)
                c.all_flags({"key": "k"})

        threads = [threading.Thread(target=reader) for _ in range(4)]
        for t in threads:
            t.start()
        for rev in range(2, 16):
            color = "green" if rev % 2 else "blue"
            edge.set_bundle(make_bundle(rev, flags={"accent": {"type": "string", "enabled": True, "default": color, "off": "x", "rules": []}}))
            c.refresh()
        stop.set()
        for t in threads:
            t.join()
        assert not bad and c.revision == 15


def test_close_is_idempotent_and_evaluations_keep_working(edge: FakeEdge) -> None:
    c = client(edge)
    c.wait_until_ready(5)
    c.close()
    c.close()
    assert c.string_variation("accent", "x") == "blue"
    assert all(not t.is_alive() for t in c._threads)


def test_missing_key_never_hangs() -> None:
    errors: List[NanoFlagsError] = []
    c = NanoFlags("", on_error=errors.append)
    assert c.wait_until_ready(1) is False and errors[-1].code == "config"
    c.close()
