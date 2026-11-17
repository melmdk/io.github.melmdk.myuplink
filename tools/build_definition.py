#!/usr/bin/env python3
"""Build drivers/nibe/devices/NibeVVM310.json and patch app.json from the myUplink point dump."""
import json, glob, os
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
os.chdir(HERE)
LANGS = ["en", "sv", "de", "da"]
pts = {l: {p["parameterId"]: p for p in json.load(open(glob.glob(f"dump/points-{l}-*.json")[0]))} for l in LANGS}

# point -> capability (existing ids reused from the VVM S320 definition where the meaning matches)
CAPS = {
    "40004": "measure_temperature",            # Outdoor temperature (BT1)
    "40008": "measure_temperature.supply4",    # Supply line (BT2)
    "40012": "measure_temperature.return14",   # Return line (BT3)
    "40013": "measure_temperature.hw6",        # Hot water top (BT7)
    "40014": "measure_temperature.hw7",        # Hot water charging (BT6)
    "40067": "measure_temperature.outdoor11",  # Average outdoor temp (BT1)
    "50004": "onoff.hwBoost1",                 # Temporary lux
    # new for the F-series
    "43009": "measure_temperature.calcSupply",
    "40121": "measure_temperature.addHeat",
    "44058": "measure_temperature.ouSupply",
    "44055": "measure_temperature.ouReturn",
    "44701": "measure_frequency.compressor",
    "32486": "measure_power.consumption",
    "43084": "measure_power.addHeat",
}
NEW_CAPS = ["43009", "40121", "44058", "44055", "44701", "32486", "43084"]
SETTINGS = {"40940": "setting_781"}                       # Degree minutes
STATUS = {"44064": "status_1965", "49994": "status_55000", "49995": "status_55021",
          "49993": "status_55027"}
EXTRA = ["40941", "48132", "47041", "43389", "50312", "44069", "44071", "44073"]  # flow-only points

def ml(get):
    d = {l: get(l) for l in LANGS}
    return d

def devpoint(pid):
    e = pts["en"][pid]
    out = {
        "parameterName": ml(lambda l: pts[l][pid]["parameterName"]),
        "parameterUnit": e["parameterUnit"],
        "writable": e["writable"],
        "minValue": e["minValue"], "maxValue": e["maxValue"],
        "enumValues": [{"value": v["value"], "text": ml(lambda l, i=i: pts[l][pid]["enumValues"][i]["text"]), "icon": v.get("icon", "")}
                       for i, v in enumerate(e["enumValues"])],
        "scaleValue": e["scaleValue"],
    }
    if e.get("stepValue") is not None: out["stepValue"] = str(e["stepValue"]).rstrip("0").rstrip(".") if "." in str(e["stepValue"]) else str(e["stepValue"])
    out["type"] = 2 if e["enumValues"] else 1
    return out

used = sorted(set(CAPS) | set(SETTINGS) | set(STATUS) | set(EXTRA), key=int)
missing = [p for p in used if p not in pts["en"]]
assert not missing, missing
definition = {
    "name": "NIBE VVM 310",
    "icon": "NibeS1255.svg",
    "basedOnHelp": "The basedOn is the deviceId of a device you want to use the myUplink dump for to create the dump",
    "basedOn": "",
    "filterHelp": "F-series indoor module VVM 310 (firmware nibe-e6); outdoor unit values (EB101) come through it",
    "filter": {"deviceName": ".*VVM 310.*"},
    "capabilities": sorted(CAPS.values()),
    "onChange": {}, "onCreated": {},
    "capTable": CAPS,
    "settingsTable": SETTINGS,
    "statusTable": STATUS,
    "ignoredTable": {},
    "unCommonTable": [int(p) for p in used],
    "optionalPoints": [],
    "devPointTable": {p: devpoint(p) for p in used},
}
json.dump(definition, open(f"{APP}/drivers/nibe/devices/NibeVVM310.json", "w"), indent=2, ensure_ascii=False)

app = json.load(open(f"{APP}/app.json"))
drv = next(d for d in app["drivers"] if d["id"] == "nibe")
for pid in NEW_CAPS:
    opt = {"title": ml(lambda l: pts[l][pid]["parameterName"])}
    u = pts["en"][pid]["parameterUnit"]
    if u: opt["units"] = u
    if CAPS[pid].startswith("measure_power"): opt["decimals"] = 2
    drv["capabilitiesOptions"][CAPS[pid]] = opt
json.dump(app, open(f"{APP}/app.json", "w"), ensure_ascii=False, separators=(",", ":"))
for pid in used:
    e = pts["en"][pid]; role = CAPS.get(pid) or SETTINGS.get(pid) or STATUS.get(pid) or "(flows)"
    print(f'{pid} {e["parameterName"].replace(chr(173),""):38} {e["value"]!s:>8} {e["parameterUnit"]:4} -> {role}' + (f' + {STATUS[pid]}' if pid in STATUS and pid in CAPS else ''))
