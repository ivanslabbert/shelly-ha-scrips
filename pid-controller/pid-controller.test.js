const { test } = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./harness");

// Build a fresh controller with known, minimal defaults; override CONFIG via
// `overrides`, then resolve derived state with start() and zero the runtime
// state so each test starts from a clean slate.
function fresh(overrides) {
  const h = load();
  h.CONFIG.kp = 0;
  h.CONFIG.ki = 0;
  h.CONFIG.kd = 0;
  h.CONFIG.direction = 1;
  h.CONFIG.outMin = 0;
  h.CONFIG.outMax = 100;
  h.CONFIG.iMin = null;
  h.CONFIG.iMax = null;
  h.CONFIG.stopIntegratingOnSaturation = true;
  h.CONFIG.sampleMs = 1000; // dt = 1.0 s, keeps the arithmetic exact
  h.CONFIG.sp = { value: 0, source: null };
  h.CONFIG.pv = {
    source: { component: "temperature:0", attr: "tC" },
    scale: 1,
    offset: 0,
  };
  h.CONFIG.cv = {
    method: "Number.Set",
    id: 200,
    param: "value",
    scale: 1,
    offset: 0,
  };
  h.CONFIG.debug = false;
  if (overrides) Object.assign(h.CONFIG, overrides);
  h.start(); // resolve iMin/iMax from the (possibly overridden) output range
  h.state.integral = 0;
  h.state.lastPV = null;
  return h;
}

test("proportional term: CV = kp * error", function () {
  const h = fresh({ kp: 2, sp: { value: 10, source: null } });
  h.setPV(8); // e = 10 - 8 = 2, P = 4
  h.tick();
  assert.equal(h.lastCV(), 4);
});

test("reverse direction flips the error sign", function () {
  const h = fresh({ kp: 1, direction: -1, sp: { value: 10, source: null } });
  h.setPV(12); // e = -1 * (10 - 12) = 2
  h.tick();
  assert.equal(h.lastCV(), 2);
});

test("integral accumulates by ki * error * dt each tick", function () {
  const h = fresh({ ki: 1, sp: { value: 10, source: null } });
  h.setPV(8); // e = 2, dt = 1
  h.tick();
  assert.equal(h.state.integral, 2);
  assert.equal(h.lastCV(), 2);
  h.tick();
  assert.equal(h.state.integral, 4);
  assert.equal(h.lastCV(), 4);
});

test("output is clamped to outMax", function () {
  const h = fresh({ kp: 1000, sp: { value: 10, source: null }, outMax: 100 });
  h.setPV(0); // P = 10000, far above the limit
  h.tick();
  assert.equal(h.lastCV(), 100);
});

test("output is clamped to outMin", function () {
  const h = fresh({ kp: 1000, sp: { value: 0, source: null }, outMin: 0 });
  h.setPV(10); // e = -10, P = -10000
  h.tick();
  assert.equal(h.lastCV(), 0);
});

test("anti-windup: integration is held while saturated and pushing out", function () {
  const h = fresh({ kp: 1000, ki: 1, sp: { value: 10, source: null } });
  h.setPV(0); // output pinned at outMax, error still positive
  h.tick();
  assert.equal(h.state.integral, 0); // not accumulated
  assert.equal(h.lastCV(), 100);
});

test("anti-windup: integral term is clamped to the output range by default", function () {
  const h = fresh({
    kp: 0,
    ki: 1,
    sp: { value: 10, source: null },
    stopIntegratingOnSaturation: false,
    outMax: 100,
  });
  h.setPV(0); // e = 10 added per tick
  for (let i = 0; i < 20; i++) h.tick();
  assert.equal(h.state.integral, 100); // 200 requested, clamped to outMax
  assert.equal(h.lastCV(), 100);
});

test("anti-windup: integral clamp respects custom iMax", function () {
  const h = fresh({
    kp: 0,
    ki: 1,
    sp: { value: 10, source: null },
    stopIntegratingOnSaturation: false,
    iMax: 5,
    outMax: 100,
  });
  h.setPV(0);
  for (let i = 0; i < 10; i++) h.tick();
  assert.equal(h.state.integral, 5);
});

test("derivative is on measurement: no kick when only the setpoint changes", function () {
  const h = fresh({
    kp: 1,
    kd: 100,
    sp: { value: 10, source: null },
    outMin: -1000,
    outMax: 1000,
  });
  h.setPV(8);
  h.tick(); // first sample: D = 0, e = 2 -> CV = 2
  assert.equal(h.lastCV(), 2);
  h.CONFIG.sp.value = 20; // setpoint jumps, PV unchanged
  h.tick(); // dPV = 0 -> D = 0, e = 12 -> CV = 12 (no derivative spike)
  assert.equal(h.lastCV(), 12);
});

test("derivative responds to a change in measurement", function () {
  const h = fresh({
    kd: 5,
    sp: { value: 0, source: null },
    outMin: -1000,
    outMax: 1000,
  });
  h.setPV(8);
  h.tick(); // first sample: D = 0 -> CV = 0
  assert.equal(h.lastCV(), 0);
  h.setPV(9); // dPV = 1 over dt = 1
  h.tick(); // D = -kd * dir * dPV = -5
  assert.equal(h.lastCV(), -5);
});

test("PV unavailable: no CV write, no crash", function () {
  const h = fresh({ kp: 1, sp: { value: 10, source: null } });
  // No setPV(): getComponentStatus returns null.
  h.tick();
  assert.equal(h.cvWrites.length, 0);
});

test("PV scale/offset and CV scale/offset are applied", function () {
  const h = fresh({
    kp: 1,
    sp: { value: 10, source: null },
    pv: {
      source: { component: "temperature:0", attr: "tC" },
      scale: 2,
      offset: 1,
    },
    cv: { method: "Number.Set", id: 200, param: "value", scale: 10, offset: 100 },
  });
  h.setPV(4); // pv = 4*2 + 1 = 9, e = 1, out = 1
  h.tick();
  assert.equal(h.lastCV(), 1 * 10 + 100); // 110
});

test("setpoint can be read from a component source", function () {
  const h = fresh({
    kp: 1,
    sp: { value: 0, source: { component: "number:200", attr: "value" } },
  });
  h.setStatus("number:200", { value: 30 });
  h.setPV(25); // e = 30 - 25 = 5
  h.tick();
  assert.equal(h.lastCV(), 5);
});

test("start() wires tick into a repeating timer", function () {
  const h = fresh();
  assert.equal(typeof h.timerCb(), "function");
});

// ---------------------------------------------------------------------------
//  Closed-loop simulation
//
//  Runs the controller against a simple first-order plant: each step we feed
//  the plant's current value in as the PV, let the controller compute a CV,
//  then advance the plant by `stepFn(pv, cv)`. A correctly-signed, stable
//  controller should drive the PV to the setpoint and hold it there.
// ---------------------------------------------------------------------------
function simulate(h, sp, startPV, stepFn, steps) {
  let pv = startPV;
  h.CONFIG.sp.value = sp;
  for (let i = 0; i < steps; i++) {
    h.setPV(pv);
    h.tick();
    pv += stepFn(pv, h.lastCV());
  }
  return pv;
}

test("closed loop (direct/heating) converges PV to SP", function () {
  const h = fresh({ kp: 5, ki: 0.5, sp: { value: 22, source: null } });
  // Heater: warms with CV, leaks toward 18 C ambient.
  const heat = function (pv, cv) {
    return 0.02 * cv - 0.05 * (pv - 18);
  };
  const pv = simulate(h, 22, 18, heat, 800);
  assert.ok(Math.abs(pv - 22) < 0.1, "PV settled at " + pv);
  // Steady-state CV must be inside the output range and non-trivial.
  assert.ok(h.lastCV() > 0 && h.lastCV() < 100);
});

test("closed loop (reverse/cooling) converges PV to SP", function () {
  const h = fresh({
    kp: 5,
    ki: 0.5,
    direction: -1,
    sp: { value: 22, source: null },
  });
  // Cooler: removes heat with CV, room drifts toward 30 C ambient.
  const cool = function (pv, cv) {
    return 0.05 * (30 - pv) - 0.02 * cv;
  };
  const pv = simulate(h, 22, 30, cool, 800);
  assert.ok(Math.abs(pv - 22) < 0.1, "PV settled at " + pv);
  assert.ok(h.lastCV() > 0 && h.lastCV() < 100);
});

test("closed loop rejects a setpoint change", function () {
  const h = fresh({ kp: 5, ki: 0.5, sp: { value: 20, source: null } });
  const heat = function (pv, cv) {
    return 0.02 * cv - 0.05 * (pv - 18);
  };
  let pv = simulate(h, 20, 18, heat, 600);
  assert.ok(Math.abs(pv - 20) < 0.1, "PV settled at " + pv);
  // Raise the setpoint and confirm the loop tracks it.
  pv = simulate(h, 24, pv, heat, 600);
  assert.ok(Math.abs(pv - 24) < 0.1, "PV tracked to " + pv);
});
