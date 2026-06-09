// solar-diverter — PID solar-surplus diverter for a Shelly EM Gen3.
//
// Reads grid power from the first CT input (em1:0 / act_power), and modulates a
// heater (0-100 %) to hold the grid at the setpoint — i.e. soak up exported
// solar surplus instead of feeding it back to the grid. The control output is
// written to a virtual Number component (number:200) for the heater controller
// to consume.
//
// SETUP (do these once, on the EM Gen3, before running):
//   1. Confirm the grid CT is on the FIRST CT input  -> component "em1:0".
//   2. Add a virtual Number component with id 200     -> component "number:200".
//      (Web UI: Settings -> Virtual components -> add Number, or via
//       Number.Create over RPC.) Range 0..100, this is the heater demand in %.
//   3. Point your heating device at number:200 (it reads the value via
//      RPC/HTTP/MQTT and sets its power accordingly).
//   4. Paste this script into Settings -> Scripts, enable "Run on startup",
//      and Start it.
//
// Engine: Shelly mJS (ES5.1 subset). `let` only (no var), no arrow functions,
// no classes/new, no closures over locals.

// ===========================================================================
//  VARIABLE SECTION — edit everything in here.
// ===========================================================================
let CONFIG = {
  // ---- Setpoint (SP): target grid power -----------------------------------
  // 0 = hold the grid at zero (no export). Bias slightly positive to keep a
  // small import margin and guarantee you never export, e.g. value: 0.1 (kW).
  sp: {
    value: 0.0,
    source: null,
  },

  // ---- Process variable (PV): grid power ----------------------------------
  // First CT input on the EM Gen3. act_power is in WATTS; scale 0.001 -> kW.
  // Sign convention assumed: import positive, export negative. If the loop
  // runs the wrong way (heater ramps DOWN while exporting), flip `direction`.
  pv: {
    source: { component: "em1:0", attr: "act_power" },
    scale: 0.001,
    offset: 0.0,
  },

  // ---- Control variable (CV): heater demand -------------------------------
  // Written to the virtual Number component number:200 as a 0..100 % demand.
  // value written = pidOut * scale + offset.
  cv: {
    method: "Number.Set",
    id: 200,
    param: "value",
    scale: 1.0,
    offset: 0.0,
  },

  // ---- Tuning (Sunsynk Lynx 6 kW exporting, 6 kW heater, no battery) -------
  kp: 10.0, // %/kW   — gentle; heater equals inverter rating
  ki: 2.0,  // %/kW/s — integral does the steady-state work
  kd: 0.0,  // keep 0; grid power is noisy

  // error = direction * (SP - PV)
  //  1 = output rises when PV < SP  (export, PV negative -> heater up)
  // -1 = reverse, if your CT polarity is flipped
  direction: 1,

  // ---- Output clamping + anti-windup --------------------------------------
  outMin: 0,
  outMax: 100, // heater demand %, 100 = full heater. Lower to reserve headroom.
  iMin: null,  // null = use the output range
  iMax: null,
  stopIntegratingOnSaturation: true,

  // ---- Loop timing --------------------------------------------------------
  sampleMs: 2000, // a touch slower than the inverter's own transient

  debug: true,
};
// ===========================================================================

let state = {
  integral: 0.0,
  lastPV: null, // for derivative-on-measurement; null until first sample
  iMin: 0.0,
  iMax: 0.0,
};

function log(msg) {
  if (CONFIG.debug) print("[diverter] " + msg);
}

function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

// Read a { component, attr } source, or return `fallback` if unavailable.
function readSource(src, fallback) {
  if (src === null || src === undefined) return fallback;
  let st = Shelly.getComponentStatus(src.component);
  if (st === null || st === undefined) return fallback;
  let v = st[src.attr];
  if (v === null || v === undefined) return fallback;
  return v;
}

function readSP() {
  return readSource(CONFIG.sp.source, CONFIG.sp.value);
}

function readPV() {
  let raw = readSource(CONFIG.pv.source, null);
  if (raw === null) return null;
  return raw * CONFIG.pv.scale + CONFIG.pv.offset;
}

function writeCV(out) {
  let value = out * CONFIG.cv.scale + CONFIG.cv.offset;
  let params = { id: CONFIG.cv.id };
  params[CONFIG.cv.param] = value;
  Shelly.call(CONFIG.cv.method, params, function (res, err, msg) {
    if (err !== 0) log("CV write failed: " + msg);
  });
}

function tick() {
  let pv = readPV();
  if (pv === null) {
    log("PV unavailable; skipping tick");
    return;
  }
  let sp = readSP();
  let dt = CONFIG.sampleMs / 1000.0;

  // Error, signed by the action direction (direct/reverse).
  let e = CONFIG.direction * (sp - pv);

  // Proportional term.
  let P = CONFIG.kp * e;

  // Derivative on measurement (avoids setpoint kick). Zero on first sample.
  let D = 0.0;
  if (state.lastPV !== null) {
    let dpv = (pv - state.lastPV) / dt;
    D = -CONFIG.kd * CONFIG.direction * dpv;
  }

  // Integral term, computed tentatively so anti-windup can veto it.
  let newI = state.integral + CONFIG.ki * e * dt;
  let unclamped = P + newI + D;
  let out = clamp(unclamped, CONFIG.outMin, CONFIG.outMax);

  // Conditional integration: if saturated and the error pushes further out,
  // do not accumulate this step.
  if (CONFIG.stopIntegratingOnSaturation && unclamped !== out) {
    let pushingOut =
      (out === CONFIG.outMax && e > 0) || (out === CONFIG.outMin && e < 0);
    if (pushingOut) newI = state.integral;
  }
  // Clamp the integral term itself (windup guard).
  newI = clamp(newI, state.iMin, state.iMax);
  state.integral = newI;

  // Final output with the committed integral.
  out = clamp(P + newI + D, CONFIG.outMin, CONFIG.outMax);

  writeCV(out);
  state.lastPV = pv;

  if (CONFIG.debug) {
    log(
      "SP=" + sp + " PV=" + pv + " e=" + e +
        " P=" + P + " I=" + newI + " D=" + D + " CV=" + out
    );
  }
}

function start() {
  // Resolve integral-clamp defaults to the output range.
  state.iMin = CONFIG.iMin === null ? CONFIG.outMin : CONFIG.iMin;
  state.iMax = CONFIG.iMax === null ? CONFIG.outMax : CONFIG.iMax;
  Timer.set(CONFIG.sampleMs, true, tick);
  log("started, direction=" + CONFIG.direction + ", sample " + CONFIG.sampleMs + "ms");
}

start();
