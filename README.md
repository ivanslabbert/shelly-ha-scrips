# shelly-ha-scrips

A collection of [Shelly Gen2+](https://shelly-api-docs.shelly.cloud/gen2/) device scripts.

Scripts run on the device's embedded **mJS** engine (a restricted ES5.1 subset) — see [Conventions](#conventions) before writing code.

## Layout

One folder per script, named for the script. Each folder is self-contained:

```
<script-name>/
  README.md          # what it does, config, install, behaviour
  <script-name>.js   # the script source (deployed to the device)
```

| Script | Description |
|--------|-------------|
| [pid-controller](pid-controller/) | Generic PID control loop for a Shelly output. |
| [solar-diverter](solar-diverter/) | Ready-to-run PID solar-surplus diverter (Shelly EM Gen3). |

## Conventions

The Shelly scripting engine is **mJS**, not full JavaScript. When writing scripts:

- Use `let` only — there is **no** `var`, and `const` is not supported.
- No `class` / `new` — build prototypes with `Object.create(proto)`.
- No closures: nested functions can't capture an enclosing function's locals (they can reference globals). Keep state in a global object.
- No arrow functions, template literals, or `Array.prototype` helpers (`map`, `forEach`, …). Use plain `for` loops and `+` string concatenation.
- `JSON.parse` / `JSON.stringify` are available; `print(...)` logs to the device console.
- Keep heap usage small — only a few KB per script. Avoid building large strings/arrays.
- Up to **3 scripts** can run concurrently on a device.
- Put tunables in a `CONFIG` object at the top of each script so the rest of the file rarely needs editing.

### Common APIs

- `Shelly.call(method, params, callback)` — invoke any RPC method (incl. `HTTP.GET/POST`).
- `Shelly.addStatusHandler(cb)` / `Shelly.addEventHandler(cb)` — react to component changes / events.
- `Shelly.getComponentStatus(key)` / `Shelly.getComponentConfig(key)` — synchronous reads, e.g. `"switch:0"`.
- `Timer.set(ms, repeat, cb)` / `Timer.clear(handle)` — scheduling.
- `HTTPServer.registerEndpoint(name, cb)` — expose an HTTP endpoint on the device.
- `MQTT.publish/subscribe/isConnected`.

## Deploying a script

Scripts can be pasted into the device web UI (**Settings → Scripts**) or pushed over RPC:

```sh
# Create a slot (returns an id), upload code, enable on boot, and start.
curl -s "http://<device-ip>/rpc/Script.Create" -d '{"name":"pid-controller"}'
curl -s "http://<device-ip>/rpc/Script.PutCode" \
  -d "$(jq -n --arg c "$(cat pid-controller/pid-controller.js)" '{id:1,code:$c}')"
curl -s "http://<device-ip>/rpc/Script.SetConfig" -d '{"id":1,"config":{"enable":true}}'
curl -s "http://<device-ip>/rpc/Script.Start" -d '{"id":1}'
```

Large files must be uploaded in chunks via repeated `Script.PutCode` calls (`append: true`).

## Testing

Script logic is unit-tested in Node (≥18) using the built-in test runner — no dependencies:

```sh
npm test            # or: node --test
```

Device scripts stay pure mJS. A small harness (e.g. [pid-controller/harness.js](pid-controller/harness.js))
loads a script with mocked `Shelly` / `Timer` / `print` globals so its internal
functions can be driven and asserted against. Test files are named `*.test.js`.
