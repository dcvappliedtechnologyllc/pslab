const test = require("node:test");
const assert = require("node:assert");

function freshDev() {
  delete require.cache[require.resolve("../lib/actions/dev")];
  return require("../lib/actions/dev");
}

function stubPs() {
  const calls = [];
  const ps = {
    action: {
      addNotificationListener(filter, handler) {
        calls.push({ filter, handler });
      },
    },
  };
  return { ps, calls };
}

test("start registers an 'all' listener once, even when called twice", () => {
  const dev = freshDev();
  const { ps, calls } = stubPs();
  dev.start(ps);
  dev.start(ps);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].filter, [{ event: "all" }]);
});

test("events carry event, descriptor and timestamp", async () => {
  const dev = freshDev();
  const { ps, calls } = stubPs();
  dev.start(ps);
  const before = Date.now();
  calls[0].handler("make", { _obj: "make" });
  const { events } = await dev.dev_events(ps, {});
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].event, "make");
  assert.deepStrictEqual(events[0].descriptor, { _obj: "make" });
  assert.ok(events[0].at >= before && events[0].at <= Date.now());
});

test("ring buffer keeps the newest 500", async () => {
  const dev = freshDev();
  const { ps, calls } = stubPs();
  dev.start(ps);
  for (let i = 0; i < 600; i++) calls[0].handler(`e${i}`, { i });
  const { events } = await dev.dev_events(ps, {});
  assert.strictEqual(events.length, 500);
  assert.strictEqual(events[0].event, "e100");
  assert.strictEqual(events[499].event, "e599");
});

test("clear:true empties the buffer after returning; otherwise it is kept", async () => {
  const dev = freshDev();
  const { ps, calls } = stubPs();
  dev.start(ps);
  calls[0].handler("a", {});
  calls[0].handler("b", {});
  assert.strictEqual((await dev.dev_events(ps, {})).events.length, 2);
  const cleared = await dev.dev_events(ps, { clear: true });
  assert.strictEqual(cleared.events.length, 2);
  assert.strictEqual((await dev.dev_events(ps, {})).events.length, 0);
});

test("returned events array is a copy", async () => {
  const dev = freshDev();
  const { ps, calls } = stubPs();
  dev.start(ps);
  calls[0].handler("a", {});
  const { events } = await dev.dev_events(ps, {});
  events.length = 0;
  assert.strictEqual((await dev.dev_events(ps, {})).events.length, 1);
});

test("start hands back the listener's promise so a rejection can be caught", async () => {
  const dev = freshDev();
  const ps = { action: { addNotificationListener: () => Promise.reject(new Error("no listener")) } };
  await assert.rejects(dev.start(ps), /no listener/);
});
