// Test harness for pid-controller.js.
//
// The device script is pure mJS and relies on the globals Shelly, Timer and
// print, plus an auto-running start() at the bottom. To unit-test the logic in
// Node without modifying the device file, we read the source, wrap it in a
// function that injects mocked globals, and expose its internal functions via
// an appended `return`. Each load() is a fresh, isolated instance.

const fs = require("fs");
const path = require("path");

function load() {
  const src = fs.readFileSync(
    path.join(__dirname, "pid-controller.js"),
    "utf8"
  );

  const statuses = {}; // component key -> mocked status object
  const cvWrites = []; // recorded Shelly.call() invocations
  const logs = [];
  let timerCb = null;

  const Shelly = {
    getComponentStatus: function (key) {
      return Object.prototype.hasOwnProperty.call(statuses, key)
        ? statuses[key]
        : null;
    },
    call: function (method, params, cb) {
      cvWrites.push({ method: method, params: params });
      if (cb) cb(null, 0, "");
    },
  };

  const Timer = {
    set: function (ms, repeat, cb) {
      timerCb = cb;
      return 1;
    },
    clear: function () {},
  };

  const print = function (m) {
    logs.push(String(m));
  };

  // Build an instance and expose the script's internals.
  const factory = new Function(
    "Shelly",
    "Timer",
    "print",
    src +
      "\nreturn { CONFIG: CONFIG, state: state, tick: tick, start: start," +
      " clamp: clamp, readPV: readPV };"
  );
  const api = factory(Shelly, Timer, print);

  return {
    CONFIG: api.CONFIG,
    state: api.state,
    tick: api.tick,
    start: api.start,
    timerCb: function () {
      return timerCb;
    },
    // Set the PV source's mocked status (defaults to temperature:0 / tC).
    setPV: function (v) {
      statuses["temperature:0"] = { tC: v };
    },
    // Set an arbitrary component status (for custom PV/SP sources).
    setStatus: function (component, obj) {
      statuses[component] = obj;
    },
    // The value written by the most recent CV write, or undefined.
    lastCV: function () {
      if (cvWrites.length === 0) return undefined;
      const w = cvWrites[cvWrites.length - 1];
      return w.params[api.CONFIG.cv.param];
    },
    cvWrites: cvWrites,
    logs: logs,
  };
}

module.exports = { load };
