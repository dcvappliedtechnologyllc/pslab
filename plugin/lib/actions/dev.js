// Dev tooling: records every Photoshop action event so batchPlay descriptors can be discovered.
const MAX_EVENTS = 500;
const buffer = [];
let started = false;

// Returns whatever addNotificationListener returns (a Promise in UXP), so the
// caller can catch an asynchronous failure too.
function start(ps) {
  if (started) return undefined;
  const pending = ps.action.addNotificationListener([{ event: "all" }], (event, descriptor) => {
    buffer.push({ event, descriptor, at: Date.now() });
    if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
  });
  started = true;
  return pending;
}

async function dev_events(ps, args = {}) {
  const events = buffer.slice();
  if (args.clear === true) buffer.length = 0;
  return { events };
}

module.exports = { start, dev_events };
