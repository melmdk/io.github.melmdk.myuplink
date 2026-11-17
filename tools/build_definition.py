#!/usr/bin/env python3
"""Build the F-series device definitions and patch app.json from the myUplink point dump.

Reads tools/dump/points-<lang>-*.json (see fetch_points.py) and writes
drivers/nibe/devices/NibeVVM310.json and NibeF2120.json. Capability ids that already exist
in the NIBE driver (from the S-series definitions) are reused where the meaning matches;
new ones get their titles from the point names.
"""
import json, glob, os
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
os.chdir(HERE)
LANGS = ["en", "sv", "de", "da"]
pts = {l: {p["parameterId"]: p for p in json.load(open(glob.glob(f"dump/points-{l}-*.json")[0]))} for l in LANGS}

# Capabilities that already have titles in the NIBE driver
EXISTING = {"measure_temperature", "measure_temperature.supply4", "measure_temperature.return14",
            "measure_temperature.hw6", "measure_temperature.hw7", "measure_temperature.outdoor11",
            "onoff.hwBoost1"}
# Optional title overrides (English) where the myUplink name is too terse
TITLES = {"nibe_value.hoursHotWater": "Operating time, hot water", "nibe_value.degreeMinutes": "Degree minutes",
          "measure_temperature.lowPressure": "Low pressure, saturation (EB101-BP8)",
          "measure_temperature.highPressure": "High pressure, saturation (EB101-BP9)",
          "nibe_value.starts": "Compressor starts", "nibe_value.hours": "Compressor operating time",
          "nibe_value.defrosting": "Defrosting (EB101)"}
FLOW_ONLY = ["48132", "47041", "43389", "50312"]

DEVICES = [
    {
        "file": "NibeVVM310.json", "name": "NIBE VVM 310",
        "filterHelp": "F-series indoor module VVM 310 (firmware nibe-e6)",
        "caps": {
            "40004": "measure_temperature",            # Outdoor temperature (BT1)
            "40008": "measure_temperature.supply4",    # Supply line (BT2)
            "40012": "measure_temperature.return14",   # Return line (BT3)
            "40013": "measure_temperature.hw6",        # Hot water top (BT7)
            "40014": "measure_temperature.hw7",        # Hot water charging (BT6)
            "40067": "measure_temperature.outdoor11",  # Average outdoor temp (BT1)
            "50004": "onoff.hwBoost1",                 # Temporary lux
            "43009": "measure_temperature.calcSupply",
            "40121": "measure_temperature.addHeat",
            "44058": "measure_temperature.ouSupply",
            "44055": "measure_temperature.ouReturn",
            "44701": "measure_frequency.compressor",
            "32486": "measure_power.consumption",
            "43084": "measure_power.addHeat",
        },
        "settings": {"40940": "setting_781"},
        "status": {"44064": "status_1965", "49994": "status_55000", "49995": "status_55021", "49993": "status_55027"},
    },
    {
        "file": "NibeF2120.json", "name": "NIBE F2120",
        "additional": True,
        "filterHelp": "F2120 outdoor unit (EB101) reported through a VVM 310; offered as an additional device",
        "caps": {
            "44701": "measure_frequency.compressor",
            "44775": "measure_frequency.requested",
            "44362": "measure_temperature.ouOutdoor",     # BT28
            "44363": "measure_temperature.evaporator",    # BT16
            "44059": "measure_temperature.discharge",     # BT14
            "44060": "measure_temperature.liquidLine",    # BT15
            "44061": "measure_temperature.suctionGas",    # BT17
            "41164": "measure_temperature.injection",     # BT81
            "41162": "measure_temperature.lowPressure",   # BP8 as saturation temperature
            "41163": "measure_temperature.highPressure",  # BP9 as saturation temperature
            "44700": "measure_pressure.low",              # BP8 in bar
            "41002": "nibe_value.fanSpeed",
            "44703": "nibe_value.defrosting",
            "40941": "nibe_value.degreeMinutes",
            "44396": "nibe_value.chargePump",
            "44069": "nibe_value.starts",
            "44071": "nibe_value.hours",
            "44073": "nibe_value.hoursHotWater",
        },
        "settings": {},
        "status": {"44064": "status_1965"},
    },
]

def ml(get):
    return {l: get(l) for l in LANGS}

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
    if e.get("stepValue") is not None:
        out["stepValue"] = str(int(e["stepValue"])) if float(e["stepValue"]).is_integer() else str(e["stepValue"])
    out["type"] = 2 if e["enumValues"] else 1
    return out

app = json.load(open(f"{APP}/app.json"))
drv = next(d for d in app["drivers"] if d["id"] == "nibe")
app.setdefault("capabilities", {})["nibe_value"] = {
    "type": "number", "title": {"en": "Value"}, "getable": True, "setable": False,
    "uiComponent": "sensor", "insights": True, "icon": "/assets/icons/myUplink.svg",
}

for dev in DEVICES:
    caps, settings, status = dev["caps"], dev["settings"], dev["status"]
    both = set(caps) & (set(settings) | set(status))
    assert not both, f"point in capTable and settings/status: {both}"
    used = sorted(set(caps) | set(settings) | set(status) | set(FLOW_ONLY), key=int)
    missing = [p for p in used if p not in pts["en"]]
    assert not missing, missing
    definition = {
        "name": dev["name"], "icon": "NibeS1255.svg",
        "basedOn": "",
        "filterHelp": dev["filterHelp"],
        "filter": {"deviceName": ".*VVM 310.*"},
        "capabilities": sorted(caps.values()),
        "onChange": {}, "onCreated": {},
        "capTable": caps, "settingsTable": settings, "statusTable": status,
        "ignoredTable": {},
        "unCommonTable": [int(p) for p in used],
        "optionalPoints": [],
        "devPointTable": {p: devpoint(p) for p in used},
    }
    if dev.get("additional"): definition["additional"] = True
    json.dump(definition, open(f"{APP}/drivers/nibe/devices/{dev['file']}", "w"), indent=2, ensure_ascii=False)
    print(dev["name"])
    for pid in used:
        e = pts["en"][pid]; cap = caps.get(pid)
        role = cap or settings.get(pid) or status.get(pid) or "(flows)"
        print(f'  {pid} {e["parameterName"].replace(chr(173), ""):38} {e["value"]!s:>8} {e["parameterUnit"]:4} -> {role}')
        if cap and cap not in EXISTING:
            opt = {"title": ml(lambda l: pts[l][pid]["parameterName"])}
            if cap in TITLES: opt["title"] = {"en": TITLES[cap]}
            if e["parameterUnit"]: opt["units"] = e["parameterUnit"]
            if cap.startswith("measure_power"): opt["decimals"] = 2
            if cap.startswith("measure_pressure"): opt["decimals"] = 1  # bar, 0.1 resolution
            drv["capabilitiesOptions"][cap] = opt

json.dump(app, open(f"{APP}/app.json", "w"), ensure_ascii=False, separators=(",", ":"))
