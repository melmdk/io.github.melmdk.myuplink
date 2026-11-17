#!/usr/bin/env python3
"""Read the myUplink access token from Homey's DB (never printed) and dump systems, device info and points."""
import sqlite3, json, os, sys, urllib.request, urllib.error
out = os.path.expanduser("~/myuplink-dump"); os.makedirs(out, exist_ok=True)
c = sqlite3.connect("file:" + os.path.expanduser("~/services/homey/data/sqlite/db.sqlite") + "?mode=ro", uri=True)
v = c.execute("select value from Entry where type='appsettings' and id='com.myuplink'").fetchone()[0]
sess = json.loads(v)["settings"]["OAuth2Sessions"]
tok = next(iter(sess.values()))["token"]["access_token"]
base = "https://api.myuplink.com"
def get(path, lang="en"):
    r = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + tok, "Accept-Language": lang, "User-Agent": "node-fetch", "Accept": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r, timeout=60))
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, path, e.read()[:200]); return None
systems = get("/v2/systems/me")
if not systems: sys.exit(1)
json.dump(systems, open(out + "/systems.json", "w"), indent=1)
for s in systems["systems"]:
    print("SYSTEM", s["name"], "premium:", s.get("hasAlarm"), [ (d["id"], d["product"]["name"]) for d in s["devices"]])
    for d in s["devices"]:
        i = d["id"]
        for name, path in (("device", f"/v2/devices/{i}"), ("firmware", f"/v2/devices/{i}/firmware-info")):
            j = get(path); json.dump(j, open(f"{out}/{name}-{i}.json", "w"), indent=1)
        for lang in ("en", "da", "sv", "de", "no"):
            p = get(f"/v2/devices/{i}/points", lang)
            json.dump(p, open(f"{out}/points-{lang}-{i}.json", "w"), indent=1)
            print(lang, "points:", len(p) if p else None)
