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

// ---------- A2: MODAL_BUSY rewrite ----------

const { modalState } = require("../lib/doc");

function modalPs({ probeThrows, layers = [], tool = null, number } = {}) {
  const doc = { id: 1, name: "a.psd", layers };
  const probes = [];
  return {
    probes,
    app: { activeDocument: doc, documents: [doc] },
    core: {
      async executeAsModal(fn, opts) {
        probes.push(opts);
        if (probeThrows) throw Object.assign(new Error("modal"), number !== undefined ? { number } : {});
        return fn({});
      },
    },
    action: {
      async batchPlay(descs) {
        if (tool === null) throw new Error("no tool read");
        return descs.map(() => ({ tool: { _enum: "tool", _value: tool } }));
      },
    },
  };
}

const noLayer = async () => {
  throw Object.assign(new Error("No layer with id 7"), { code: "NO_LAYER" });
};

test("NO_LAYER during a crop becomes MODAL_BUSY (crop), probed once with a short timeout", async () => {
  const p = modalPs({ probeThrows: true, layers: [{ id: 9, name: "Crop Preview" }, { id: 1, name: "Background" }] });
  const dispatch = createDispatcher(p, { set_layer: noLayer }, { docSummary: summary, modalState: (x, d) => modalState(x, d) });
  const r = await dispatch(req("r-1", "set_layer", { layer: 7 }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "MODAL_BUSY");
  assert.match(r.error.message, /modal state \(crop\)/);
  assert.match(r.error.message, /commit or cancel/);
  assert.equal(p.probes.length, 1);
  assert.equal(p.probes[0].timeOut, 1);
  assert.equal(p.probes[0].commandName, "pslab modal probe");
});

test("a probe that resolves leaves NO_LAYER as is", async () => {
  const p = modalPs({ probeThrows: false });
  const dispatch = createDispatcher(p, { set_layer: noLayer }, { docSummary: summary, modalState: (x, d) => modalState(x, d) });
  const r = await dispatch(req("r-1", "set_layer", { layer: 7 }));
  assert.deepEqual(r.error, { code: "NO_LAYER", message: "No layer with id 7" });
});

test("errors outside the modal-suspect set are never probed; no hook means no probe", async () => {
  const p = modalPs({ probeThrows: true });
  const bad = async () => {
    throw Object.assign(new Error("bad"), { code: "INVALID_ARGS" });
  };
  const dispatch = createDispatcher(p, { bad, set_layer: noLayer }, { docSummary: summary, modalState: (x, d) => modalState(x, d) });
  assert.equal((await dispatch(req("r-1", "bad", {}))).error.code, "INVALID_ARGS");
  assert.equal(p.probes.length, 0);
  const plain = createDispatcher(p, { set_layer: noLayer }, { docSummary: summary });
  assert.equal((await plain(req("r-2", "set_layer", {}))).error.code, "NO_LAYER");
  assert.equal(p.probes.length, 0);
});

test("a MODAL_BUSY from validation passes through unchanged, without a second probe", async () => {
  const p = modalPs({ probeThrows: true, tool: "cropTool" });
  const busy = async () => {
    throw Object.assign(new Error("Photoshop is in a modal state (crop); commit or cancel it, then retry"), { code: "MODAL_BUSY" });
  };
  const dispatch = createDispatcher(p, { busy }, { docSummary: summary, modalState: (x, d) => modalState(x, d) });
  const r = await dispatch(req("r-1", "busy", {}));
  assert.deepEqual(r.error, { code: "MODAL_BUSY", message: "Photoshop is in a modal state (crop); commit or cancel it, then retry" });
  assert.equal(p.probes.length, 0);
});

test("NO_LAYER stays NO_LAYER when the modal probe itself throws", async () => {
  const p = modalPs({ probeThrows: false });
  const throwing = async () => {
    throw new Error("probe broke");
  };
  const dispatch = createDispatcher(p, { set_layer: noLayer }, { docSummary: summary, modalState: throwing });
  const r = await dispatch(req("r-1", "set_layer", { layer: 7 }));
  assert.deepEqual(r.error, { code: "NO_LAYER", message: "No layer with id 7" });
});

test("modalState classifies by tool, hint, busy (error 9) and unknown (brush/move are not transform)", async () => {
  assert.equal(await modalState(modalPs({ probeThrows: false }), null), null);
  assert.equal(await modalState(modalPs({ probeThrows: true, tool: "cropTool" }), null), "crop");
  assert.equal(await modalState(modalPs({ probeThrows: true, tool: "typeCreateOrEditTool" }), null), "text");
  assert.equal(await modalState(modalPs({ probeThrows: true, tool: "typeVerticalCreateOrEditTool" }), null), "text");
  // Free Transform runs on whatever tool is selected; only marquee tools are known to mean it
  assert.equal(await modalState(modalPs({ probeThrows: true, tool: "marqueeRectTool" }), null), "transform");
  assert.equal(await modalState(modalPs({ probeThrows: true, tool: "marqueeEllipTool" }), null), "transform");
  assert.equal(await modalState(modalPs({ probeThrows: true, tool: "moveTool" }), null), "unknown");
  assert.equal(await modalState(modalPs({ probeThrows: true, tool: "paintbrushTool" }), null), "unknown");
  assert.equal(await modalState(modalPs({ probeThrows: true, number: 9, tool: "moveTool" }), null), "busy");
  assert.equal(await modalState(modalPs({ probeThrows: true }), null), "unknown");
  // a hint from Photoshop's modal events wins over the tool read
  assert.equal(await modalState(modalPs({ probeThrows: true, tool: "moveTool" }), null, "dialog"), "dialog");
});

test("requireNotModal throws MODAL_BUSY with the kind, and passes when not modal", async () => {
  const { requireNotModal } = require("../lib/doc");
  await requireNotModal(modalPs({ probeThrows: false }), null);
  await assert.rejects(requireNotModal(modalPs({ probeThrows: true, tool: "cropTool" }), null), {
    code: "MODAL_BUSY",
    message: "Photoshop is in a modal state (crop); commit or cancel it, then retry",
  });
});
