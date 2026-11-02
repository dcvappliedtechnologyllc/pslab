const test = require("node:test");
const assert = require("node:assert/strict");
const { createDispatcher } = require("../lib/dispatch");

const DOC = { id: 1, name: "a.psd" };
const ps = { app: { activeDocument: DOC } };
const summary = async (_ps, d) => (d ? { id: d.id, summary: true } : null);
const req = (id, action, args) => ({ type: "request", id, action, args });

test("unknown action answers UNKNOWN_ACTION without running anything", async () => {
  const dispatch = createDispatcher(ps, {}, { docSummary: summary });
  assert.deepEqual(await dispatch(req("r-1", "nope", {})), {
    type: "response",
    id: "r-1",
    ok: false,
    error: { code: "UNKNOWN_ACTION", message: "Unknown action: nope" },
  });
  // inherited names are not actions
  const r = await dispatch(req("r-2", "toString", {}));
  assert.equal(r.error.code, "UNKNOWN_ACTION");
});

test("a thrown error keeps its code, else PLUGIN_ERROR", async () => {
  const coded = Object.assign(new Error("No document open"), { code: "NO_DOCUMENT" });
  const dispatch = createDispatcher(ps, {
    coded: async () => {
      throw coded;
    },
    plain: async () => {
      throw new Error("boom");
    },
  }, { docSummary: summary });
  assert.deepEqual((await dispatch(req("r-1", "coded", {}))).error, { code: "NO_DOCUMENT", message: "No document open" });
  assert.deepEqual((await dispatch(req("r-2", "plain", {}))).error, { code: "PLUGIN_ERROR", message: "boom" });
});

test("an undefined result becomes null and the active document summary rides along", async () => {
  let seenArgs;
  const dispatch = createDispatcher(ps, {
    act: async (p, args) => {
      seenArgs = [p, args];
    },
  }, { docSummary: summary });
  assert.deepEqual(await dispatch({ type: "request", id: "r-1", action: "act" }), {
    type: "response",
    id: "r-1",
    ok: true,
    result: null,
    doc: { id: 1, summary: true },
  });
  assert.deepEqual(seenArgs, [ps, {}]);
});

test("doc is null when the summary fails, and the failure is reported", async () => {
  const errors = [];
  const dispatch = createDispatcher(ps, { act: async () => ({ x: 1 }) }, {
    docSummary: async () => {
      throw new Error("summary broke");
    },
    onError: (m) => errors.push(m),
  });
  const r = await dispatch(req("r-1", "act", {}));
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { x: 1 });
  assert.equal(r.doc, null);
  assert.deepEqual(errors, ["document summary failed: summary broke"]);
});

test("two concurrent requests run one after the other, in order", async () => {
  const log = [];
  let releaseFirst;
  const firstHeld = new Promise((r) => (releaseFirst = r));
  const dispatch = createDispatcher(ps, {
    first: async () => {
      log.push("first start");
      await firstHeld;
      log.push("first end");
      return 1;
    },
    second: async () => {
      log.push("second start");
      return 2;
    },
  }, { docSummary: summary });
  const a = dispatch(req("r-1", "first", {}));
  const b = dispatch(req("r-2", "second", {}));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(log, ["first start"]);
  releaseFirst();
  assert.equal((await b).result, 2);
  assert.equal((await a).result, 1);
  assert.deepEqual(log, ["first start", "first end", "second start"]);
});

test("a failed request does not block the queue", async () => {
  const dispatch = createDispatcher(ps, {
    bad: async () => {
      throw new Error("x");
    },
    good: async () => "ok",
  }, { docSummary: summary });
  const [a, b] = await Promise.all([dispatch(req("r-1", "bad", {})), dispatch(req("r-2", "good", {}))]);
  assert.equal(a.ok, false);
  assert.equal(b.result, "ok");
});

test("the summary follows args.doc (or dst_doc), else the active document", async () => {
  const OTHER = { id: 2, name: "b.psd" };
  const ps2 = { app: { activeDocument: DOC, documents: [DOC, OTHER] } };
  const dispatch = createDispatcher(ps2, { noop: async () => "ok" }, { docSummary: summary });
  assert.equal((await dispatch(req("r-1", "noop", { doc: 2 }))).doc.id, 2);
  assert.equal((await dispatch(req("r-2", "noop", { dst_doc: 2 }))).doc.id, 2);
  assert.equal((await dispatch(req("r-3", "noop", {}))).doc.id, 1);
  assert.equal((await dispatch(req("r-4", "noop", { doc: 99 }))).doc.id, 1);
});
