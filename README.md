# myUplink F-series (unofficial) for Homey

Unofficial fork of the **myUplink** Homey app by myUpTech AB (`com.myuplink`, version 1.2.24,
GPL-3.0), taken from the app as distributed through the Homey App Store. Not affiliated with or
supported by myUpTech, NIBE or Athom.

The official app only has device definitions for the NIBE S-series. This fork adds one for the
F-series:

| Device | Definition | Notes |
|---|---|---|
| NIBE VVM 310 (with F2120 outdoor unit) | `drivers/nibe/devices/NibeVVM310.json` | firmware `nibe-e6`; the outdoor unit's values (EB101) come through the indoor module |

Pair it with **Devices → + → myUplink F-series (unofficial) → NIBE**.

## What the VVM 310 device exposes

- Temperatures: outdoor (BT1) and its average, supply (BT2), return (BT3), hot water top (BT7)
  and charging (BT6), calculated supply, additional heat (BT63), outdoor unit supply/return
- Compressor frequency, current power consumption and immersion heater power (both in kW)
- Switch: temporary lux (more hot water)
- Settings page: degree minutes, compressor status, priority, heating medium pump, electric
  additional heat
- Further points (hot water demand, hot water boost, operating hours, starts) through the
  app's flow cards

Changing values from Homey may require a myUplink premium subscription.

## Changes from the original

- App id and name changed so it installs next to (and is never overwritten by) the official app
- Added `NibeVVM310.json` and the capability titles it needs in `app.json`
- Removed the publisher's environment variants (`configuration/`)
- Added `tools/` (see below)

## myUplink API credentials

`env.json` is **not** in this repository. Create it with your own application from
<https://dev.myuplink.com> (callback URL `https://callback.athom.com/oauth2/callback`):

```json
{
  "CLIENT_ID": "...",
  "CLIENT_SECRET": "...",
  "MYUPLINK_API_URL": "https://api.myuplink.com"
}
```

## Adding another F-series model

1. Pair the device once with the **Generic Device** driver so Homey holds a login.
2. `tools/fetch_points.py` (run on the Homey host) dumps the device's points in all languages.
3. Adapt the point selection in `tools/build_definition.py` and run it; it writes the definition
   file and adds the capability titles to `app.json`.
4. `npm ci`, then `homey app validate` and `homey app install`.

A point can be in `capTable` or in `statusTable`/`settingsTable`, not both.

## License

GPL-3.0, as the original. See `LICENSE`.
