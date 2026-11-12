#!/usr/bin/env python3
"""Verify the Python SDK against the hosted edge with the public live demo.

    NANOFLAGS_SDK_KEY=<demo browser key> python scripts/live_verify.py [--toggles 5] [--gap 4]

1. Starts a client with default settings (official edge: signatures verified against the embedded key, unsigned
   bundles refused) and waits for the live socket.
2. Checks offline that a tampered copy of the real signed bundle does not verify.
3. Toggles ``demo-accent`` through ``POST /v1/demo/toggle`` (public, rate-limited — keep it gentle) and measures
   POST returned → ``on_change`` in Python, and the commit → update latency the SDK reports.
4. Restores the original value.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from nanoflags import OFFICIAL_EDGE_URL, OFFICIAL_SIGNING_KEYS, NanoFlags, UpdateEvent  # noqa: E402
from nanoflags._http import http_request  # noqa: E402
from nanoflags.verify import SignatureInfo, import_public_keys, raw_member, verify_bundle_text  # noqa: E402

COLORS = ["blue", "orange", "green"]


def toggle(flag: str, value: object) -> dict:
    req = urllib.request.Request(f"{OFFICIAL_EDGE_URL}/v1/demo/toggle", data=json.dumps({"flag": flag, "value": value}).encode(), method="POST", headers={"Content-Type": "application/json", "User-Agent": "nanoflags-python-verify"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = json.loads(e.read() or b"{}")
        body["httpStatus"] = e.code
        return body


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--toggles", type=int, default=5)
    ap.add_argument("--gap", type=float, default=4.0, help="seconds between toggles")
    args = ap.parse_args()
    key = os.environ.get("NANOFLAGS_SDK_KEY")
    if not key:
        print("set NANOFLAGS_SDK_KEY", file=sys.stderr)
        return 2

    updates: "list[tuple[float, UpdateEvent]]" = []
    cond = threading.Condition()
    errors = []

    def on_change(e: UpdateEvent) -> None:
        with cond:
            updates.append((time.perf_counter(), e))
            cond.notify_all()

    t0 = time.perf_counter()
    flags = NanoFlags(key, service="python-sdk-verify", on_change=on_change, on_error=errors.append, events=False)
    ok = flags.wait_until_ready(15)
    t_ready = time.perf_counter() - t0
    print(f"ready={ok} in {t_ready * 1000:.0f} ms  status={flags.status} revision={flags.revision} verified_kid={flags._sig.kid if flags._sig else None} env={flags._sig.environment_id if flags._sig else None}")
    deadline = time.time() + 15
    while flags.transport != "live" and time.time() < deadline:
        time.sleep(0.05)
    print(f"transport={flags.transport} (live socket open after {(time.perf_counter() - t0) * 1000:.0f} ms)")
    print("values:", flags.all_flags({"key": "python-verify"}))
    d = flags.string_variation_detail("demo-accent", "none")
    print(f"detail demo-accent: value={d.value!r} reason={d.reason} revision={d.revision}")

    # Offline tamper check against the real signed response.
    res = http_request("GET", f"{OFFICIAL_EDGE_URL}/v1/bundle", {"Authorization": f"Bearer {key}", "User-Agent": "nanoflags-python-verify"}, None, 10)
    assert res.status == 200, res.status
    text = res.text()
    body = json.loads(text)
    info = SignatureInfo(res.headers.get("X-NanoFlags-Signature") or "", res.headers.get("X-NanoFlags-Key-Id"), res.headers.get("X-NanoFlags-Environment-Id") or "", body["revision"], body["checksum"])
    keys = import_public_keys(OFFICIAL_SIGNING_KEYS)
    raw = raw_member(text, "bundle") or ""
    tampered = raw.replace('"default":false', '"default":true', 1) if '"default":false' in raw else raw[:-1] + " }"
    print(f"offline: genuine verifies={verify_bundle_text(keys, info, raw)}  tampered verifies={verify_bundle_text(keys, info, tampered)}")

    original = flags.string_variation("demo-accent", "blue")
    current = original
    samples = []
    for i in range(args.toggles):
        nxt = COLORS[(COLORS.index(current) + 1) % len(COLORS)] if current in COLORS else "orange"
        before = len(updates)
        t_post = time.perf_counter()
        r = toggle("demo-accent", nxt)
        t_returned = time.perf_counter()
        if r.get("status") != "published":
            print(f"toggle {i + 1}: {r.get('status') or r.get('error', {}).get('code')} {r.get('httpStatus', '')} retryAfterMs={r.get('retryAfterMs') or r.get('error', {}).get('retryAfterMs')}")
            wait = (r.get("retryAfterMs") or 5000) / 1000
            time.sleep(min(30, wait + 1))
            continue
        with cond:
            cond.wait_for(lambda: any(e.revision >= r["revision"] for _, e in updates[before:]), timeout=15)
        got = [(t, e) for t, e in updates[before:] if e.revision >= r["revision"]]
        if not got:
            print(f"toggle {i + 1}: r{r['revision']} published but no update within 15 s")
            continue
        t_update, ev = got[0]
        value = flags.string_variation("demo-accent", "?")
        sample = {"revision": ev.revision, "value": value, "expected": nxt, "transport": ev.transport, "post_rtt_ms": (t_returned - t_post) * 1000, "post_returned_to_update_ms": (t_update - t_returned) * 1000, "post_sent_to_update_ms": (t_update - t_post) * 1000, "commit_to_update_ms": ev.latency_ms}
        samples.append(sample)
        print(f"toggle {i + 1}: r{ev.revision} {nxt} -> python saw {value!r} via {ev.transport}; POST rtt {sample['post_rtt_ms']:.0f} ms, POST returned→update {sample['post_returned_to_update_ms']:.0f} ms, POST sent→update {sample['post_sent_to_update_ms']:.0f} ms, commit→update (SDK) {ev.latency_ms if ev.latency_ms is None else round(ev.latency_ms)} ms")
        current = nxt
        time.sleep(args.gap)

    if current != original:
        r = toggle("demo-accent", original)
        print(f"restored demo-accent={original}: {r.get('status')}")
    if samples:
        for k in ("post_sent_to_update_ms", "post_returned_to_update_ms", "commit_to_update_ms"):
            xs = [s[k] for s in samples if isinstance(s[k], (int, float))]
            if xs:
                print(f"{k}: n={len(xs)} median={statistics.median(xs):.0f} min={min(xs):.0f} max={max(xs):.0f}")
        print("all values matched:", all(s["value"] == s["expected"] for s in samples), " all live:", all(s["transport"] == "live" for s in samples))
    print("errors:", [f"{e.code}: {e}" for e in errors])
    flags.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
