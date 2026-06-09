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
