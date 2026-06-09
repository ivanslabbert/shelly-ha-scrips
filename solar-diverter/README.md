# solar-diverter

A ready-to-run PID **solar-surplus diverter** for a Shelly EM Gen3. It holds the
grid at zero by modulating a heater (0–100 %) to soak up exported solar, instead
of feeding surplus back to the grid.

This is the generic [pid-controller](../pid-controller/) with the config baked in
for one specific setup — copy [solar-diverter.js](solar-diverter.js) straight into
the device. The control logic is identical and is covered by the
[pid-controller tests](../pid-controller/pid-controller.test.js).

## My setup

| | |
|---|---|
| Meter | Shelly EM Gen3, 50 A CT on the **first CT input** (`em1:0`), on the grid feed |
| Inverter | Sunsynk Lynx 6 kW, **exporting to grid** (not zero-export) |
| Battery | none |
| Load | 6 kW heater, accepts a 0–100 % demand |
| Output | virtual Number `number:200` (heater controller reads it) |

## Install

1. Confirm the grid CT is on the **first** CT input → component `em1:0`.
2. Add a virtual **Number** component with **id 200** (`number:200`), range 0–100.
   Web UI: *Settings → Virtual components → add Number*, or `Number.Create` over RPC.
   This holds the heater demand in %.
3. Point the heating device at `number:200` (it reads the value over RPC/HTTP/MQTT
   and sets its power).
4. Paste `solar-diverter.js` into *Settings → Scripts*, enable **Run on startup**,
   and **Start** it.

## First-run checklist

- **Check the sign.** While exporting, the heater should ramp **up**. If it ramps
  down, your CT polarity is reversed — set `direction: -1` in the config.
- **Watch the log** (the script prints `SP/PV/e/P/I/D/CV` each tick with
  `debug: true`). PV is grid power in kW (negative = exporting). Set `debug: false`
  once you're happy.
- **No export guarantee.** To never export at all, bias the setpoint slightly
  positive: `sp.value = 0.1` (≈100 W import margin).

## Tuning notes

Gains are deliberately gentle (`kp: 10`, `ki: 2`, `kd: 0`, `sampleMs: 2000`) because
the 6 kW heater equals the inverter rating — a large proportional step could demand
load faster than the inverter ramps and cause a brief import, so the integral does
the steady-state work. See the
[pid-controller README](../pid-controller/README.md#tuning-with-a-sunsynk-lynx-6-kw-and-a-6-kw-heater)
for the full reasoning, output-headroom (`outMax`) options, and the no-battery note.
