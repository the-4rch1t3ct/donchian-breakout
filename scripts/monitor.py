#!/usr/bin/env python3
import os, sys, json, time, subprocess
from datetime import datetime, timezone

LOG_PATH = os.environ.get("DB_LOG_PATH", "/home/botadmin/donchian-breakout/logs/donchian_breakout.jsonl")
STATE_PATH = os.environ.get("DB_MONITOR_STATE", "/home/botadmin/donchian-breakout/logs/monitor_state.json")
TELEGRAM_TARGET = os.environ.get("DB_TELEGRAM_TARGET", "").strip()
PROC_MATCH = os.environ.get("DB_PROC_MATCH", "MODE=live")

CRITICAL_EVENTS = {
    "EXCHANGE_API_ERROR",
    "KILL_SWITCH_TRIGGERED",
    "FLATTEN_ALL",
    "ORDER_BLOCKED_MAX_NOTIONAL",
    "STARTUP_CONNECTIVITY_FAIL",
}

MICRO_EVENT = "SKIPPED_BAD_MICROSTRUCTURE"
MICRO_THRESH = int(os.environ.get("DB_MICRO_THRESH", "3"))
MICRO_WINDOW_SECS = int(os.environ.get("DB_MICRO_WINDOW_SECS", str(10 * 60)))

def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def load_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def save_state(st):
    tmp = STATE_PATH + ".tmp"
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=2, sort_keys=True)
    os.replace(tmp, STATE_PATH)

def is_runner_alive():
    try:
        r = subprocess.run(["pgrep", "-f", PROC_MATCH], capture_output=True, text=True)
        if r.returncode != 0:
            return (False, [])
        pids = [p for p in r.stdout.strip().splitlines() if p.strip().isdigit()]
        return (len(pids) > 0, pids)
    except Exception:
        return (False, [])

def send_alert(text):
    if not TELEGRAM_TARGET:
        print(f"[{utc_now_iso()}] ALERT (no DB_TELEGRAM_TARGET): {text}", file=sys.stderr)
        return False
    cmd = ["clawdbot", "message", "send", "--target", TELEGRAM_TARGET, "--message", text]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[{utc_now_iso()}] Failed to send alert: {r.stderr}", file=sys.stderr)
            return False
        return True
    except Exception as e:
        print(f"[{utc_now_iso()}] Exception sending alert: {e}", file=sys.stderr)
        return False

def read_new_lines(path, last_offset, max_bytes=2_000_000):
    try:
        size = os.stat(path).st_size
    except FileNotFoundError:
        return (last_offset or 0, [])

    if last_offset is None or last_offset < 0 or last_offset > size:
        last_offset = 0

    start = last_offset
    if size - start > max_bytes:
        start = max(0, size - max_bytes)

    with open(path, "rb") as f:
        f.seek(start)
        data = f.read()
        new_offset = f.tell()

    text = data.decode("utf-8", errors="replace")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return (new_offset, lines)

def parse_ts(evt):
    ts = evt.get("timestamp")
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        return datetime.fromisoformat(ts).timestamp()
    except Exception:
        return None

def stable_evt_id(evt):
    raw = json.dumps(evt, sort_keys=True, separators=(",", ":"))
    # NOTE: python hash is randomized per process; make it stable
    import hashlib
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

def main():
    state = load_state()
    last_offset = state.get("offset", 0)
    micro_hits = state.get("micro_hits", [])

    alive, pids = is_runner_alive()
    last_alive = state.get("last_alive")

    if last_alive is None:
        last_alive = alive

    if (not alive) and last_alive:
        send_alert(f"donchian-breakout runner DOWN (no process match: {PROC_MATCH}).")
    if alive and (not last_alive):
        send_alert(f"donchian-breakout runner UP (pids={','.join(pids)}).")

    new_offset, lines = read_new_lines(LOG_PATH, last_offset)

    critical_found = []
    now = time.time()

    for ln in lines:
        try:
            evt = json.loads(ln)
        except Exception:
            continue
        evname = (evt.get("event") or "").strip()
        if not evname:
            continue
        if evname in CRITICAL_EVENTS:
            critical_found.append(evt)
        if evname == MICRO_EVENT:
            t = parse_ts(evt) or now
            micro_hits.append(t)

    cutoff = now - MICRO_WINDOW_SECS
    micro_hits = [t for t in micro_hits if t >= cutoff]

    sent_ids = set(state.get("sent_ids", []))

    for evt in critical_found:
        eid = stable_evt_id(evt)
        if eid in sent_ids:
            continue
        msg = (
            f"donchian-breakout CRITICAL: {evt.get('event')}\n"
            f"time={evt.get('timestamp','?')} module={evt.get('module','?')} symbol={evt.get('symbol','')}\n"
            f"details={json.dumps(evt.get('details', {}), ensure_ascii=False)}"
        )
        send_alert(msg)
        sent_ids.add(eid)

    last_micro_alert = float(state.get("last_micro_alert_ts", 0) or 0)
    if len(micro_hits) >= MICRO_THRESH and (now - last_micro_alert) > MICRO_WINDOW_SECS:
        send_alert(
            f"donchian-breakout WARNING: {len(micro_hits)}× {MICRO_EVENT} in last {MICRO_WINDOW_SECS//60}m "
            f"(threshold={MICRO_THRESH})."
        )
        last_micro_alert = now

    state["offset"] = new_offset
    state["last_alive"] = alive
    state["micro_hits"] = micro_hits[-200:]
    state["last_micro_alert_ts"] = last_micro_alert
    state["sent_ids"] = list(sent_ids)[-500:]
    save_state(state)

if __name__ == "__main__":
    main()
