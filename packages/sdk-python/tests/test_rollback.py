"""Rollback / replay protection (K1) and the status after a rejected update (K2).

Revisions only grow per environment: every publish (a kill switch, a rollout step, restoring an old revision, which
publishes it as a new one) is ``published_revision + 1``. So with ``verify``, a bundle older than one this client already
verified is a replayed or stale response and is never adopted.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any, List, Optional

import pytest
from conftest import FakeEdge, make_bundle, wait_for
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import nanoflags.client as client_module
from nanoflags import NanoFlags, NanoFlagsError, UpdateEvent, VerifyOptions


def client(edge: FakeEdge, **kw: Any) -> NanoFlags:
    opts: dict = dict(base_url=edge.base_url, live_url=edge.live_url, verify=VerifyOptions(public_keys=[edge.jwk], require=True), events=False, poll_interval=30, streaming=False)
    opts.update(kw)
    return NanoFlags("nf_srv_test", **opts)


class Recorder:
    def __init__(self, c: NanoFlags) -> None:
        self.errors: List[NanoFlagsError] = []
        self.updates: List[UpdateEvent] = []
        self.statuses: List[str] = []
        c.on("error", self.errors.append)
        c.on("update", self.updates.append)
        c.on("status", self.statuses.append)

    @property
    def codes(self) -> List[str]:
        return [e.code for e in self.errors]


def started(edge: FakeEdge, **kw: Any) -> "tuple[NanoFlags, Recorder]":
    c = client(edge, start=False, **kw)
    rec = Recorder(c)
    c.start()
    return c, rec


def push_only(edge: FakeEdge, bundle: dict, t: str = "rev", then: Optional[dict] = None, sign_key: Any = None) -> None:
    """Send ``bundle`` over the live sockets only; /v1/bundle keeps serving ``then`` (default: what it served before)."""
    before = edge.text and json.loads(edge.text)
    edge.set_bundle(bundle)
    msg = edge.message(t, sign_key=sign_key)
    edge.set_bundle(then or before)
    for ws in list(edge.sockets):
        ws.send(msg)


# ---------------------------------------------------------------------------------------------------------------- K1


def test_fetch_older_signed_revision_is_refused_reported_and_client_turns_stale(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(5))
    c, rec = started(edge)
    try:
        assert c.wait_until_ready(5) and c.revision == 5
        edge.set_bundle(make_bundle(4))  # a replayed answer: genuinely signed, no stale marker
        c.refresh()
        assert c.revision == 5
        assert [u.revision for u in rec.updates] == [5]
        assert rec.codes == ["rollback"]
        assert "older than r5" in str(rec.errors[0])
        assert c.status == "stale"
        # The edge confirms the current revision again: ready; newer revisions are adopted as usual.
        edge.set_bundle(make_bundle(5))
        c.refresh()
        assert c.status == "ready"
        edge.set_bundle(make_bundle(6))
        c.refresh()
        assert c.revision == 6
        assert rec.statuses[-2:] == ["stale", "ready"]
    finally:
        c.close()


def test_poll_refuses_it_too(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(5))
    c, rec = started(edge, poll_interval=0.25)
    try:
        assert c.wait_until_ready(5)
        edge.set_bundle(make_bundle(3))
        assert wait_for(lambda: bool(rec.errors))
        assert c.revision == 5 and "rollback" in rec.codes and c.status == "stale"
    finally:
        c.close()


def test_stripping_the_signature_does_not_get_around_it(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(5))
    c, rec = started(edge, verify=VerifyOptions(public_keys=[edge.jwk], require=False))
    try:
        assert c.wait_until_ready(5)
        edge.signed = False
        edge.set_bundle(make_bundle(4))
        c.refresh()
        assert c.revision == 5 and rec.codes == ["rollback"]
        # An unsigned NEWER answer is still accepted with require=False, as before.
        edge.set_bundle(make_bundle(6))
        c.refresh()
        assert c.revision == 6 and c.status == "ready"
    finally:
        c.close()


def test_an_older_copy_marked_stale_by_the_edge_keeps_todays_behaviour(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(5))
    c, rec = started(edge)
    try:
        assert c.wait_until_ready(5)
        edge.stale = True
        edge.set_bundle(make_bundle(4))
        c.refresh()
        assert c.revision == 5 and c.status == "stale" and rec.errors == []
    finally:
        c.close()


def test_restoring_an_old_revision_publishes_a_higher_one_which_is_adopted(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(7, flags={"accent": {"type": "string", "enabled": False, "default": "x", "off": "killed", "rules": []}}))
    c, rec = started(edge)
    try:
        assert c.wait_until_ready(5) and c.string_variation("accent", "fb") == "killed"
        edge.set_bundle(make_bundle(8))  # "restore r5" = r5's configuration published as r8
        c.refresh()
        assert c.revision == 8 and c.string_variation("accent", "fb") == "blue" and c.status == "ready" and rec.errors == []
    finally:
        c.close()


def test_a_bundle_signed_for_another_environment_never_moves_the_floor(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(5))
    c, rec = started(edge)
    try:
        assert c.wait_until_ready(5)
        edge.env_id = "6f0c7c1e-0000-4000-8000-00000000ffff"
        edge.set_bundle(make_bundle(900))
        c.refresh()
        assert c.revision == 5 and rec.codes == ["signature"]
        edge.env_id = "11111111-2222-3333-4444-555555555555"
        edge.set_bundle(make_bundle(6))
        c.refresh()
        assert c.revision == 6  # the foreign r900 was not counted
    finally:
        c.close()


def test_unverified_sources_never_block_updates(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(5))
    c, rec = started(edge, bootstrap=make_bundle(9))
    try:
        assert c.wait_until_ready(5)
        c.refresh()
        assert c.revision == 5 and rec.errors == []  # the bootstrap is trusted as given but is not a verified revision
    finally:
        c.close()
    c, rec = started(edge, verify=False)
    try:
        assert c.wait_until_ready(5)
        edge.set_bundle(make_bundle(4))
        c.refresh()
        assert c.revision == 4 and rec.errors == []  # without verification there is nothing to anchor a revision on
    finally:
        c.close()


# ------------------------------------------------------------------------------------------------- K1: the store


def stored_r5(edge: FakeEdge, path: Any) -> None:
    edge.set_bundle(make_bundle(5))
    c, _ = started(edge, cache_path=str(path))
    assert c.wait_until_ready(5)
    assert wait_for(lambda: path.exists())
    c.close()


def test_after_a_restart_an_older_answer_than_the_stored_verified_revision_is_refused(edge: FakeEdge, tmp_path: Any) -> None:
    path = tmp_path / "flags.json"
    stored_r5(edge, path)
    edge.set_bundle(make_bundle(4))
    c, rec = started(edge, cache_path=str(path))
    try:
        c.wait_until_ready(5)
        assert wait_for(lambda: "rollback" in rec.codes)
        assert c.revision == 5
        assert [(u.revision, u.source) for u in rec.updates] == [(5, "store")]
        assert c.status == "stale"
    finally:
        c.close()


class SlowStore:
    def __init__(self, value: Optional[str], delay: float) -> None:
        self.value, self.delay = value, delay

    def get(self) -> Optional[str]:
        time.sleep(self.delay)
        return self.value

    def set(self, value: str) -> None:
        self.value = value


def test_a_network_answer_that_beats_the_slow_store_is_not_adopted_either(edge: FakeEdge, tmp_path: Any) -> None:
    path = tmp_path / "flags.json"
    stored_r5(edge, path)
    edge.set_bundle(make_bundle(4))
    c, rec = started(edge, store=SlowStore(path.read_text(), 0.5))
    try:
        c.refresh()  # asked from this thread while the store is still being read
        assert wait_for(lambda: c.revision == 5)
        assert wait_for(lambda: "rollback" in rec.codes)
        assert [u.revision for u in rec.updates] == [5]  # r4 was never in use, not even briefly
    finally:
        c.close()


def test_a_stored_copy_older_than_the_edges_revision_is_replaced_without_error(edge: FakeEdge, tmp_path: Any) -> None:
    path = tmp_path / "flags.json"
    stored_r5(edge, path)
    edge.set_bundle(make_bundle(6))
    c, rec = started(edge, cache_path=str(path))
    try:
        assert wait_for(lambda: c.revision == 6)
        assert c.status == "ready" and rec.errors == []
    finally:
        c.close()


def test_another_sdk_key_does_not_read_the_old_keys_stored_copy(edge: FakeEdge, tmp_path: Any) -> None:
    path = tmp_path / "flags.json"
    stored_r5(edge, path)
    edge.set_bundle(make_bundle(4))
    c = NanoFlags("nf_srv_rotated", base_url=edge.base_url, verify=VerifyOptions(public_keys=[edge.jwk], require=True), events=False, streaming=False, cache_path=str(path), start=False)
    rec = Recorder(c)
    c.start()
    try:
        assert c.wait_until_ready(5) and c.revision == 4 and rec.errors == []
    finally:
        c.close()


# --------------------------------------------------------------------------------------------- K1: live transport


def test_a_signed_older_push_is_refused_and_reported_then_http_confirms_the_current_one(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(5))
    c, rec = started(edge, streaming=True, poll_interval=0)
    try:
        assert c.wait_until_ready(5) and wait_for(lambda: c.transport == "live")
        edge.push(make_bundle(6))
        assert wait_for(lambda: c.revision == 6)
        # e.g. a replayed `hello` for r5 on the same socket while /v1/bundle serves r6.
        push_only(edge, make_bundle(5), "hello", then=make_bundle(6))
        assert wait_for(lambda: "rollback" in rec.codes)
        assert c.revision == 6
        # The refusal asked the verified path what is current: it confirms r6 again.
        assert wait_for(lambda: c.status == "ready")
        assert [u.revision for u in rec.updates] == [5, 6]
    finally:
        c.close()


def test_a_forged_older_push_is_reported_as_signature(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(5))
    c, rec = started(edge, streaming=True, poll_interval=0)
    try:
        assert c.wait_until_ready(5) and wait_for(lambda: c.transport == "live")
        push_only(edge, make_bundle(4), sign_key=Ed25519PrivateKey.generate())
        assert wait_for(lambda: "signature" in rec.codes)
        assert c.revision == 5 and "rollback" not in rec.codes
    finally:
        c.close()


def test_an_http_answer_older_than_a_revision_pushed_a_moment_ago_is_dropped_silently(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(5))
    c, rec = started(edge, streaming=True, poll_interval=0)
    try:
        assert c.wait_until_ready(5) and wait_for(lambda: c.transport == "live")
        push_only(edge, make_bundle(6), then=make_bundle(5))  # the HTTP path (KV) still serves r5
        assert wait_for(lambda: c.revision == 6)
        c.refresh()
        assert c.revision == 6 and c.status == "ready" and rec.errors == []
    finally:
        c.close()


def test_after_the_grace_window_the_same_older_http_answer_is_reported(edge: FakeEdge, monkeypatch: pytest.MonkeyPatch) -> None:
    edge.set_bundle(make_bundle(5))
    c, rec = started(edge, streaming=True, poll_interval=0)
    try:
        assert c.wait_until_ready(5) and wait_for(lambda: c.transport == "live")
        push_only(edge, make_bundle(6), then=make_bundle(5))
        assert wait_for(lambda: c.revision == 6)
        monkeypatch.setattr(client_module, "_ROLLBACK_GRACE", 0.0)  # stands in for "2 minutes later"
        c.refresh()
        assert c.revision == 6 and rec.codes == ["rollback"] and c.status == "stale"
    finally:
        c.close()


def test_an_http_answer_requested_before_a_push_was_adopted_is_dropped_silently(edge: FakeEdge, monkeypatch: pytest.MonkeyPatch) -> None:
    edge.set_bundle(make_bundle(5))
    c, rec = started(edge, streaming=True, poll_interval=0)
    try:
        assert c.wait_until_ready(5) and wait_for(lambda: c.transport == "live")
        monkeypatch.setattr(client_module, "_ROLLBACK_GRACE", 0.0)  # only the ordering rule can explain the drop
        gate = threading.Event()
        edge.bundle_gate = gate
        edge.set_bundle(make_bundle(4))
        before = edge.count("/v1/bundle")
        slow = threading.Thread(target=c.refresh)
        slow.start()
        assert wait_for(lambda: edge.count("/v1/bundle") > before)  # the request is in flight, holding r4
        push_only(edge, make_bundle(6), then=make_bundle(6))
        assert wait_for(lambda: c.revision == 6)
        gate.set()
        slow.join(10)
        assert c.revision == 6 and c.status == "ready" and rec.errors == []
    finally:
        c.close()


# ---------------------------------------------------------------------------------------------------------------- K2


def test_tampered_update_turns_stale_until_a_bundle_verifies(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(3))
    c, rec = started(edge)
    try:
        assert c.wait_until_ready(5)
        edge.set_bundle(make_bundle(4))
        edge.tamper = True
        c.refresh()
        assert c.revision == 3 and c.status == "stale" and rec.codes == ["signature"]
        edge.tamper = False
        c.refresh()
        assert c.revision == 4 and c.status == "ready"
        assert rec.statuses[-2:] == ["stale", "ready"]
    finally:
        c.close()


def test_tampered_push_turns_stale_then_the_verified_path_confirms(edge: FakeEdge) -> None:
    c, rec = started(edge, streaming=True, poll_interval=0)
    try:
        assert c.wait_until_ready(5) and wait_for(lambda: c.transport == "live")
        edge.push(make_bundle(2), tamper=True)
        assert wait_for(lambda: "signature" in rec.codes)
        assert wait_for(lambda: c.revision == 2 and c.status == "ready")  # the HTTP path serves the genuine r2
        assert "stale" in rec.statuses
    finally:
        c.close()


def test_the_edges_unsigned_answer_during_publisher_lag_is_not_a_reason_for_stale(edge: FakeEdge) -> None:
    edge.set_bundle(make_bundle(3))
    c, rec = started(edge)
    try:
        assert c.wait_until_ready(5)
        edge.set_bundle(make_bundle(4))
        edge.signed = False
        c.refresh()
        assert c.status == "ready" and c.revision == 3 and rec.codes == ["signature"]
    finally:
        c.close()


def test_an_unsupported_engine_leaves_the_status_unchanged(edge: FakeEdge) -> None:
    c, rec = started(edge)
    try:
        assert c.wait_until_ready(5)
        edge.set_bundle(make_bundle(2, engine=99))
        c.refresh()
        assert c.status == "ready" and rec.codes == ["engine"]
    finally:
        c.close()


def test_first_load_rejected_leaves_the_client_not_ready(edge: FakeEdge) -> None:
    edge.tamper = True
    c, rec = started(edge)
    try:
        assert c.wait_until_ready(5) is False
        assert c.status == "not-ready" and rec.codes[0] == "signature"
    finally:
        c.close()
