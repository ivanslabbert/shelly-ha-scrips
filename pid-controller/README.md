# pid-controller

A generic [PID](https://en.wikipedia.org/wiki/Proportional%E2%80%93integral%E2%80%93derivative_controller)
control loop running on a Shelly device, with anti-windup.

## What it does

On a fixed interval it reads a **process variable (PV)**, compares it to a
**setpoint (SP)**, and drives a **control variable (CV)** to minimise the error
using proportional, integral, and derivative terms. PV and SP can each be read
live from any device component or pinned to a fixed value; CV is written to any
component through an RPC method.

All wiring and tuning live in the `CONFIG` block at the top of
[pid-controller.js](pid-controller.js) — the loop below it rarely needs editing.

## Connecting PV, SP and CV

| Signal | How it's connected |
|--------|--------------------|
| **SP** | `sp.value` (fixed) or `sp.source = { component, attr }` to track a component. |
| **PV** | `pv.source = { component, attr }`, then `pv = raw * scale + offset`. |
| **CV** | Written via `cv.method` with the value in `params[cv.param]`; `value = pidOut * scale + offset`. |

`component`/`attr` map to a Shelly status object, e.g. `{ component: "temperature:0", attr: "tC" }`.
CV examples: `Number.Set` (virtual number), `Light.Set` + `brightness` (0–100 dimmer),
`PWM.Set` + `duty` with `scale: 0.01` (0–1).

## Tuning parameters

| Key | Meaning |
|-----|---------|
| `kp` | Proportional gain. |
| `ki` | Integral gain (per second). |
| `kd` | Derivative gain (seconds). |
| `direction` | Action direction; sets the sign of the error (`error = direction * (SP - PV)`). `1` = direct acting, output rises when PV < SP (e.g. heating); `-1` = reverse acting, output rises when PV > SP (e.g. cooling). |
| `sampleMs` | Control loop interval, in milliseconds. |

## Output clamping & anti-windup

The output is clamped to `[outMin, outMax]`. Windup is prevented two ways:

- **Integral clamp** — the integral term is held within `[iMin, iMax]`
  (default `null` → the output range).
- **Conditional integration** — when `stopIntegratingOnSaturation` is true,
  integration pauses while the output is saturated *and* the error would push
  it further past the limit, so the integral can't accumulate against a stop.

## Example: solar surplus diverter (Shelly EM Gen3)

Hardware: Shelly EM Gen3 with a 50 A CT on the **first CT input**, clamped on the
grid feed. Goal: dump excess solar into a heating element so net grid power stays
at zero instead of exporting.

- **PV** — grid power from the first CT input, `em1:0` / `act_power`. This is in
  **watts**, so `scale: 0.001` converts it to kW. Sign convention: import positive,
  export negative (flip with `direction` if your CT reads the other way).
- **SP** — `0`. Hold the grid at zero; surplus (negative PV) raises the error and
  drives the heater up until import/export balances.
- **CV** — written to a **virtual Number component** (`number:200`) as a 0–100 %
  heater demand. Another device (the heater controller) reads that value over
  RPC/HTTP/MQTT. Add the virtual `number:200` component on the device first.

```js
// CONFIG overrides for this use case:
sp: { value: 0, source: null },                          // target 0 kW at the grid CT

pv: {
  source: { component: "em1:0", attr: "act_power" },     // first CT input, in watts
  scale: 0.001,                                          // W -> kW
  offset: 0.0,
},

cv: {
  method: "Number.Set",                                  // write to a virtual Number...
  id: 200,                                               // ...number:200, read by the heater
  param: "value",
  scale: 1.0,
  offset: 0.0,
},

kp: 10.0,          // %/kW  — gentle; see the Sunsynk notes below
ki: 2.0,           // %/kW/s
kd: 0.0,           // leave at 0; power signals are noisy
direction: 1,      // 1 if export reads negative; flip to -1 if it runs the wrong way

outMin: 0,
outMax: 100,       // heater demand, percent (100 % = full heater)
sampleMs: 2000,    // slower than the inverter's own regulation loop
```

Notes:

- **Check the sign first.** If enabling the loop makes the heater ramp *down* while
  you're exporting, your CT polarity is reversed — set `direction: -1`.
- To guarantee you never export (at the cost of importing a little), bias the
  setpoint slightly positive, e.g. `sp.value = 0.1` (≈100 W of import headroom).
- `kd: 0` — power measurements are noisy; a derivative term would amplify that.
- If the heater only accepts on/off rather than a 0–100 % level, a raw PID doesn't
  map cleanly — you'd want time-proportioning (PWM-style duty cycling) on top.

### Tuning with a Sunsynk Lynx 6 kW (and a 6 kW heater)

This setup runs the **inverter in export-to-grid mode**, so the Sunsynk is *not*
curtailing surplus to hold the grid at zero. That's the clean, stable arrangement:
real surplus shows up as genuine export (negative PV), and this loop simply soaks it
into the heater to bring the grid back toward zero — no two controllers fighting over
the same signal. The remaining tuning concerns are about the heater/inverter sizing
and measurement noise:

- **The heater (6 kW) equals the inverter rating, so a big proportional step can
  demand more load than the inverter can ramp instantly** → a brief grid import →
  the loop backs off → oscillation. Hence the gentle `kp: 10` and modest `ki: 2`:
  let the integral walk the heater up and settle. Raise gains only if it tracks too
  slowly, and only a little at a time.
- **Keep the loop a touch slower than the inverter's transient** (`sampleMs: 2000`,
  or 3000) so the heater rides the average surplus rather than chasing every PV/MPPT
  wobble.
- **Reserve headroom for house loads.** With weak sun, a 6 kW heater plus household
  demand can exceed available PV and pull from the grid. The loop self-limits
  (import → negative error → back off), but if you want a hard margin, cap `outMax`
  (e.g. `80` ≈ 4.8 kW) so the heater can never claim the inverter's full output.
- **No battery (this setup).** Controlling on *grid export* is the right choice
  regardless of a battery — it's the most downstream measurement, so the loop just
  soaks whatever would otherwise be exported. The only practical difference is that
  without a battery to buffer them, PV transients (passing clouds) hit grid export
  directly, so the heater is the sole fast sink. The gentle gains plus `sampleMs:
  2000` are a deliberate balance: responsive enough to follow real surplus swings,
  slow enough not to chase momentary noise.

> If you ever switch the inverter to **zero-export**, revisit this: the inverter
> would then curtail surplus to hold the grid at 0, the loop would see no error, and
> the heater would never ramp. Export-enabled is what gives the diverter a signal to
> act on.

## Implementation notes

- Derivative is taken **on the measurement** (PV), not the error, to avoid a
  derivative kick when the setpoint changes.
- Fixed-rate `dt = sampleMs / 1000` is used; keep `sampleMs` realistic for the
  device — very short intervals waste cycles and heap.
- Set `debug: false` once tuned to cut console logging.

## Install

See the root [README](../README.md#deploying-a-script): create a script slot,
`Script.PutCode` with the contents of `pid-controller.js`, enable on boot, start.

## Tests

The control logic is covered by [pid-controller.test.js](pid-controller.test.js),
run via the built-in Node test runner (see the root [README](../README.md#testing)):

```sh
npm test
```

[harness.js](harness.js) loads the device script with mocked `Shelly` / `Timer` /
`print` globals so `tick()` can be driven directly. The suite covers:

- **Unit** — the P, I and D terms, direct/reverse direction, output clamping,
  both anti-windup mechanisms (conditional integration and integral clamp),
  derivative-on-measurement (no setpoint kick), PV/SP component sources, and
  scale/offset handling.
- **Closed-loop** — the controller run against a first-order plant model
  (heating and cooling), asserting the PV converges to the SP and tracks a
  setpoint change. This catches sign/tuning regressions the unit tests can't.

> Note: `Shelly.call` / `getComponentStatus` are mocked, so a wrong `cv.method`
> or `attr` name still passes tests but fails on-device — verify on real hardware.
