// pid-controller — generic PID control loop for Shelly (mJS).
//
// Reads a process variable (PV), compares it to a setpoint (SP), and drives a
// control variable (CV) using a PID law with anti-windup. PV and SP can be
// read from any device component or set to a fixed value; CV is written to any
// component via an RPC method.
//
// Engine: Shelly mJS (ES5.1 subset). `let` only (no var), no arrow functions,
// no classes/new, no closures over locals.

// ===========================================================================
//  VARIABLE SECTION — edit everything in here.
// ===========================================================================
let CONFIG = {
  // ---- Setpoint (SP): the target value -----------------------------------
  // The fixed `value` is used when `source` is null. To track a component
  // instead, set source, e.g. { component: "number:200", attr: "value" }.
  sp: {
    value: 22.0,
    source: null,
  },

  // ---- Process variable (PV): the measured input -------------------------
  // Read from a component's status; `attr` is the field on that status object.
  // Applied as: pv = raw * scale + offset.
  pv: {
    source: { component: "temperature:0", attr: "tC" },
    scale: 1.0,
    offset: 0.0,
  },

  // ---- Control variable (CV): the actuator output ------------------------
  // The PID output (after clamping) is written via `method`, placed in
  // params[param]. Value written = pidOut * scale + offset. Examples:
  //   { method: "Number.Set", id: 200, param: "value" }       // virtual number
  //   { method: "Light.Set",  id: 0,   param: "brightness" }  // 0..100 dimmer
  //   { method: "PWM.Set",    id: 0,   param: "duty", scale: 0.01 } // 0..1
  cv: {
    method: "Number.Set",
    id: 200,
    param: "value",
    scale: 1.0,
    offset: 0.0,
  },

  // ---- Tuning ------------------------------------------------------------
  kp: 1.0,
  ki: 0.1, // per second
  kd: 0.0, // seconds

  // Controller action direction. This sets the sign of the error term:
  //   error = direction * (SP - PV)
  //    1 = direct acting  — output rises when PV is below SP (e.g. heating)
  //   -1 = reverse acting — output rises when PV is above SP (e.g. cooling)
  direction: 1,

  // ---- Output clamping + anti-windup -------------------------------------
  outMin: 0,
  outMax: 100,
  // Integral term is clamped to this range. null = use the output range.
  iMin: null,
  iMax: null,
  // Also hold integration while the output is saturated and the error would
  // push it further past the limit (conditional integration).
  stopIntegratingOnSaturation: true,

  // ---- Loop timing -------------------------------------------------------
  sampleMs: 1000,

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
  if (CONFIG.debug) print("[pid] " + msg);
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
