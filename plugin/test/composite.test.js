const test = require("node:test");
const assert = require("node:assert/strict");
const composite = require("../lib/actions/composite");
const D = require("../lib/descriptors");

// Stub ps with two documents (src id 1, dst id 2) and a third that is active
// at the start (id 3), so restoring the active document is observable.
// Layers model the DOM calls copy_to uses: duplicate(), duplicate(doc), delete().
function makeStub({
  selection = { left: 10, top: 20, right: 110, bottom: 70 },
  pastedBounds = { left: 0, top: 0, right: 100, bottom: 50 },
  dupToDocThrows = false,
  emptyFirstPaste = false,
  dupReturnsUndefined = false,
  fallbackThrows = false,
} = {}) {
  const calls = [];
  let nextId = 100;
  let nextDocId = 50;

  function makeDoc(id, name, profile) {
    return { id, name, colorProfileName: profile, layers: [], activeLayers: [], selection: { bounds: null } };
  }

  function makeLayer(doc, id, name, bounds) {
    const layer = {
      id,
      _name: name,
      bounds: { ...bounds },
      get name() {
        return this._name;
      },
      set name(v) {
        calls.push(["rename", this.id, v]);
        this._name = v;
      },
      async duplicate(target) {
        if (target === undefined) {
          calls.push(["duplicate", this.id, "in place"]);
          const l = makeLayer(doc, nextId++, `${this._name} copy`, this.bounds);
          doc.layers.unshift(l);
          doc.activeLayers = [l];
          return l;
        }
        calls.push(["duplicate", this.id, target.id]);
        if (doc.id === 1 && dupToDocThrows) throw new Error("paste profile mismatch");
        if (doc.id !== 1 && fallbackThrows) throw new Error("converted copy failed too");
        const empty = doc.id === 1 && emptyFirstPaste;
        const b = empty ? { left: 0, top: 0, right: 0, bottom: 0 } : pastedBounds;
        const l = makeLayer(target, nextId++, this._name, b);
        target.layers.unshift(l);
        target.activeLayers = [l];
        return dupReturnsUndefined ? undefined : l;
      },
      delete() {
        calls.push(["deleteLayer", this.id, doc.id]);
        doc.layers = doc.layers.filter((x) => x !== this);
      },
    };
    return layer;
  }

  const src = makeDoc(1, "0092.jpg", "sRGB IEC61966-2.1");
  const dst = makeDoc(2, "1645.heic", "Display P3");
  const third = makeDoc(3, "other.psd", "sRGB IEC61966-2.1");
  src.layers = [makeLayer(src, 10, "Background", { left: 0, top: 0, right: 400, bottom: 300 })];
  src.activeLayers = [src.layers[0]];
  src.selection.bounds = selection;
  dst.layers = [makeLayer(dst, 20, "Background", { left: 0, top: 0, right: 800, bottom: 600 })];
  dst.activeLayers = [dst.layers[0]];

  src.duplicate = async () => {
    calls.push(["duplicateDoc", src.id]);
    const tmp = makeDoc(nextDocId++, "tmp", src.colorProfileName);
    tmp.layers = src.layers.map((l) => makeLayer(tmp, nextId++, l.name, l.bounds));
    tmp.convertProfile = async (profile, intent) => {
      calls.push(["convertProfile", tmp.id, profile, intent]);
      tmp.colorProfileName = profile;
    };
    tmp.closeWithoutSaving = () => {
      calls.push(["closeDoc", tmp.id]);
      ps.app.documents = ps.app.documents.filter((x) => x !== tmp);
    };
    ps.app.documents.push(tmp);
    active = tmp;
    return tmp;
  };

  let active = third;
  const ps = {
    calls,
    src,
    dst,
    third,
    app: {
      documents: [src, dst, third],
      get activeDocument() {
        return active;
      },
      set activeDocument(v) {
        calls.push(["activate", v.id]);
        active = v;
      },
    },
    constants: { Intent: { RELATIVECOLORIMETRIC: "relativeColorimetric" } },
    core: {
      async executeAsModal(fn, options) {
        calls.push(["executeAsModal", options.commandName]);
        return fn({
          hostControl: {
            async suspendHistory(o) {
              calls.push(["suspendHistory", o]);
              return o.documentID * 10;
            },
            async resumeHistory(id, commit) {
              calls.push(["resumeHistory", id, commit]);
            },
            async registerAutoCloseDocument(id) {
              calls.push(["registerAutoClose", id]);
            },
            async unregisterAutoCloseDocument(id) {
              calls.push(["unregisterAutoClose", id]);
            },
          },
        });
      },
    },
    action: {
      async batchPlay(descs) {
        calls.push(["batchPlay", descs]);
        return descs.map((desc) => {
          if (desc._obj === "transform") {
            const l = active.activeLayers[0];
            const w = desc.width._value / 100;
            const b = l.bounds;
            const cx = (b.left + b.right) / 2 + desc.offset.horizontal._value;
            const cy = (b.top + b.bottom) / 2 + desc.offset.vertical._value;
            const hw = ((b.right - b.left) * w) / 2;
            const hh = ((b.bottom - b.top) * w) / 2;
            l.bounds = { left: cx - hw, top: cy - hh, right: cx + hw, bottom: cy + hh };
          }
          if (desc._obj === "select" && desc._target[0]._ref === "layer") {
            const l = active.layers.find((x) => x.id === desc._target[0]._id);
            if (l) active.activeLayers = [l];
          }
          if (desc._obj === "autoCutout" || desc.deepSelect) {
            active.selection.bounds = { left: 12, top: 22, right: 98, bottom: 64 };
          }
          return {};
        });
      },
    },
  };
  return ps;
}

const strip = (desc) => {
  const { _options, ...rest } = desc;
  return rest;
};
const allDescs = (ps) => ps.calls.filter((c) => c[0] === "batchPlay").flatMap((c) => c[1]).map(strip);
const suspends = (ps) => ps.calls.filter((c) => c[0] === "suspendHistory").map((c) => c[1]);
const modalCount = (ps) => ps.calls.filter((c) => c[0] === "executeAsModal").length;
const transformArgs = { scale_pct: 200, cx: 500, cy: 300 };
const applyMask = { _obj: "delete", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }], apply: true };

// ---------- select_object ----------

test("select_object returns bounds and uses objectSelect/selectSubject by mode", async () => {
  const bbox = { left: 10, top: 20, right: 110, bottom: 70 };
  for (const [mode, builder] of [["object", () => D.objectSelect(bbox)], ["subject", () => D.selectSubject()]]) {
    const ps = makeStub();
    ps.src.selection.bounds = null;
    const res = await composite.select_object(ps, { doc: 1, bbox, mode });
    assert.deepEqual(res, { bounds: { left: 12, top: 22, right: 98, bottom: 64 } });
    assert.deepEqual(suspends(ps), [{ documentID: 1, name: `Claude: select_object, ${mode}` }]);
    assert.deepEqual(allDescs(ps), [D.selectRectangle(bbox), builder()]);
  }
});

test("select_object works in the target document and restores the previously active one", async () => {
  const ps = makeStub();
  ps.src.selection.bounds = null;
  await composite.select_object(ps, { doc: 1, bbox: { left: 10, top: 20, right: 110, bottom: 70 }, mode: "object" });
  const activations = ps.calls.filter((c) => c[0] === "activate").map((c) => c[1]);
  assert.deepEqual(activations, [1, 3]);
  assert.equal(ps.app.activeDocument, ps.third);
  // the selection stays in the target document for copy_to
  assert.ok(ps.src.selection.bounds);
});

test("select_object rejects a bad bbox or mode before any step", async () => {
  const ps = makeStub();
  await assert.rejects(
    composite.select_object(ps, { doc: 1, bbox: { left: 50, top: 0, right: 10, bottom: 10 }, mode: "object" }),
    (e) => e.code === "INVALID_BBOX",
  );
  await assert.rejects(
    composite.select_object(ps, { doc: 1, bbox: { left: 0, top: 0, right: 10, bottom: 10 }, mode: "lasso" }),
    (e) => e.code === "INVALID_MODE",
  );
  assert.equal(modalCount(ps), 0);
});

test("select_object throws EMPTY_SELECTION when nothing was found", async () => {
  const ps = makeStub();
  ps.action.batchPlay = async (descs) => {
    ps.src.selection.bounds = null;
    return descs.map(() => ({}));
  };
  await assert.rejects(
    composite.select_object(ps, { doc: 1, bbox: { left: 0, top: 0, right: 10, bottom: 10 }, mode: "subject" }),
    (e) => e.code === "EMPTY_SELECTION",
  );
  assert.ok(ps.calls.some((c) => c[0] === "resumeHistory" && c[2] === false));
});

// ---------- copy_to ----------

test("copy_to centers after scale", async () => {
  const ps = makeStub();
  const res = await composite.copy_to(ps, { src_doc: 1, dst_doc: 2, transform: transformArgs, name: "Mushroom" });
  const t = allDescs(ps).find((x) => x._obj === "transform");
  assert.deepEqual(t, D.transform({ scalePct: 200, dx: 450, dy: 275 }));
  assert.equal(t.width._value, 200);
  assert.equal(t.height._value, 200);
  const pasted = ps.dst.layers[0];
  assert.equal(res.layer_id, pasted.id);
  assert.notEqual(res.layer_id, 20);
  assert.deepEqual(res.bounds, { left: 400, top: 250, right: 600, bottom: 350 });
  assert.equal(pasted.name, "Mushroom");
  // the temp duplicate in src is gone, the original stays
  assert.deepEqual(ps.src.layers.map((l) => l.id), [10]);
  // on success the destination is left active
  assert.equal(ps.app.activeDocument, ps.dst);
});

test("history suspended once per document", async () => {
  const ps = makeStub();
  await composite.copy_to(ps, { src_doc: 1, dst_doc: 2, transform: transformArgs, name: "Mushroom" });
  assert.deepEqual(suspends(ps), [
    { documentID: 1, name: "Claude: copy_to, prep" },
    { documentID: 2, name: "Claude: copy_to, Mushroom @ 500,300 x200%" },
  ]);
  assert.deepEqual(
    ps.calls.filter((c) => c[0] === "resumeHistory"),
    [["resumeHistory", 20, true], ["resumeHistory", 10, true]],
  );
  assert.equal(modalCount(ps), 1);
});

test("copy_to uses selection only when asked", async () => {
  const withSel = makeStub();
  await composite.copy_to(withSel, { src_doc: 1, dst_doc: 2, transform: transformArgs });
  const d1 = allDescs(withSel);
  assert.ok(d1.some((x) => JSON.stringify(x) === JSON.stringify(D.makeMaskFromSelection("reveal"))));
  assert.ok(d1.some((x) => JSON.stringify(x) === JSON.stringify(applyMask)));

  const noSel = makeStub({ selection: null });
  await composite.copy_to(noSel, { src_doc: 1, dst_doc: 2, use_selection: false, transform: transformArgs });
  const d2 = allDescs(noSel);
  assert.ok(!d2.some((x) => x._obj === "make" || x._obj === "delete"));
  assert.deepEqual(suspends(noSel)[1].name, "Claude: copy_to, pasted @ 500,300 x200%");
  // without name the pasted layer is "<source layer> from <source document>"
  assert.equal(noSel.dst.layers[0].name, "Background from 0092.jpg");
});

test("copy_to throws NO_SELECTION before any step when use_selection and no selection", async () => {
  const ps = makeStub({ selection: null });
  await assert.rejects(
    composite.copy_to(ps, { src_doc: 1, dst_doc: 2, transform: transformArgs }),
    (e) => e.code === "NO_SELECTION",
  );
  assert.equal(modalCount(ps), 0);
});

test("copy_to rejects missing documents and layers before any step", async () => {
  const ps = makeStub();
  await assert.rejects(composite.copy_to(ps, { src_doc: 9, dst_doc: 2, transform: transformArgs }), (e) => e.code === "NO_DOCUMENT");
  await assert.rejects(composite.copy_to(ps, { src_doc: 1, dst_doc: 9, transform: transformArgs }), (e) => e.code === "NO_DOCUMENT");
  await assert.rejects(
    composite.copy_to(ps, { src_doc: 1, src_layer: 99, dst_doc: 2, transform: transformArgs }),
    (e) => e.code === "NO_LAYER",
  );
  await assert.rejects(
    composite.copy_to(ps, { src_doc: 1, dst_doc: 2, transform: { scale_pct: 0, cx: 1, cy: 1 } }),
    (e) => e.code === "INVALID_TRANSFORM",
  );
  assert.equal(modalCount(ps), 0);
});

test("fallback path taken when duplicate(dst) throws", async () => {
  const ps = makeStub({ dupToDocThrows: true });
  const res = await composite.copy_to(ps, { src_doc: 1, dst_doc: 2, transform: transformArgs });
  const tmpId = 50;
  assert.ok(ps.calls.some((c) => c[0] === "duplicateDoc" && c[1] === 1));
  assert.ok(ps.calls.some((c) => c[0] === "registerAutoClose" && c[1] === tmpId));
  assert.ok(ps.calls.some((c) => c[0] === "convertProfile" && c[1] === tmpId && c[2] === "Display P3" && c[3] === "relativeColorimetric"));
  assert.ok(ps.calls.some((c) => c[0] === "closeDoc" && c[1] === tmpId));
  assert.ok(!ps.app.documents.some((x) => x.id === tmpId));
  assert.equal(ps.dst.layers[0].id, res.layer_id);
  assert.equal(ps.dst.layers.length, 2);
  assert.deepEqual(ps.src.layers.map((l) => l.id), [10]);
  assert.equal(ps.app.activeDocument, ps.dst);
});

test("fallback path taken when the pasted layer is empty, and the empty layer is removed", async () => {
  const ps = makeStub({ emptyFirstPaste: true });
  const res = await composite.copy_to(ps, { src_doc: 1, dst_doc: 2, transform: transformArgs });
  assert.ok(ps.calls.some((c) => c[0] === "convertProfile"));
  assert.equal(ps.dst.layers.length, 2);
  assert.equal(ps.dst.layers[0].id, res.layer_id);
  assert.deepEqual(res.bounds, { left: 400, top: 250, right: 600, bottom: 350 });
});

test("copy_to failure in the dst phase rolls back both documents and restores the active document", async () => {
  const ps = makeStub();
  const bp = ps.action.batchPlay;
  ps.action.batchPlay = async (descs) => {
    if (descs.some((x) => x._obj === "transform")) return descs.map(() => ({ _obj: "error", message: "boom" }));
    return bp(descs);
  };
  await assert.rejects(composite.copy_to(ps, { src_doc: 1, dst_doc: 2, transform: transformArgs }), (e) => e.code === "BATCHPLAY");
  assert.deepEqual(
    ps.calls.filter((c) => c[0] === "resumeHistory"),
    [["resumeHistory", 20, false], ["resumeHistory", 10, false]],
  );
  // dst rollback undoes the paste: no extra modal, no Delete Layer state in dst
  assert.equal(modalCount(ps), 1);
  assert.ok(!ps.calls.some((c) => c[0] === "deleteLayer" && c[2] === 2));
  assert.equal(ps.app.activeDocument, ps.third);
});

test("copy_to failure in the src phase rolls back both documents and restores the active document", async () => {
  const ps = makeStub();
  const bp = ps.action.batchPlay;
  ps.action.batchPlay = async (descs) => {
    if (descs.some((x) => x._obj === "delete")) return descs.map(() => ({ _obj: "error", message: "no mask" }));
    return bp(descs);
  };
  await assert.rejects(composite.copy_to(ps, { src_doc: 1, dst_doc: 2, transform: transformArgs }), (e) => e.code === "BATCHPLAY");
  assert.deepEqual(ps.dst.layers.map((l) => l.id), [20]);
  assert.deepEqual(
    ps.calls.filter((c) => c[0] === "resumeHistory"),
    [["resumeHistory", 20, false], ["resumeHistory", 10, false]],
  );
  assert.equal(ps.app.activeDocument, ps.third);
});

test("copy_to finds the pasted layer when duplicate(dst) returns nothing", async () => {
  const ps = makeStub({ dupReturnsUndefined: true });
  const res = await composite.copy_to(ps, { src_doc: 1, dst_doc: 2, transform: transformArgs });
  assert.ok(!ps.calls.some((c) => c[0] === "duplicateDoc"));
  assert.equal(res.layer_id, ps.dst.layers[0].id);
  assert.notEqual(res.layer_id, 20);
  assert.equal(ps.dst.layers.length, 2);
  assert.deepEqual(res.bounds, { left: 400, top: 250, right: 600, bottom: 350 });
});

test("copy_to keeps the first error when the fallback also fails", async () => {
  const ps = makeStub({ dupToDocThrows: true, fallbackThrows: true });
  await assert.rejects(
    composite.copy_to(ps, { src_doc: 1, dst_doc: 2, transform: transformArgs }),
    (e) => e.code === "COPY_FAILED" && /paste profile mismatch/.test(e.message) && /converted copy failed too/.test(e.message),
  );
  assert.ok(ps.calls.some((c) => c[0] === "closeDoc" && c[1] === 50));
  assert.equal(ps.app.activeDocument, ps.third);
});

test("select_object reads unit-value bounds and treats NaN bounds as empty", async () => {
  const bbox = { left: 0, top: 0, right: 10, bottom: 10 };
  const ps = makeStub();
  ps.action.batchPlay = async (descs) => {
    ps.src.selection.bounds = { left: { _value: 1 }, top: { value: 2 }, right: 8, bottom: 9 };
    return descs.map(() => ({}));
  };
  assert.deepEqual(await composite.select_object(ps, { doc: 1, bbox, mode: "object" }), {
    bounds: { left: 1, top: 2, right: 8, bottom: 9 },
  });
  const ps2 = makeStub();
  ps2.action.batchPlay = async (descs) => {
    ps2.src.selection.bounds = { left: NaN, top: 0, right: 8, bottom: 9 };
    return descs.map(() => ({}));
  };
  await assert.rejects(composite.select_object(ps2, { doc: 1, bbox, mode: "object" }), (e) => e.code === "EMPTY_SELECTION");
});

// ---------- refine_edge, match_tone, blur_layer ----------

// One document (id 7, 1000x800) with a pasted layer 30 above the background 20.
// getPixels serves `layerPixels` (RGBA, applyAlpha false) for layerID reads and
// `refPixel` (RGB) for composite reads.
function makeFinishStub({
  hasMask = false,
  layerPixels = null,
  refPixel = [140, 140, 140],
  refComponents = 3,
  kind = "pixel",
  preClipped = null,
  otherActive = false,
} = {}) {
  const calls = [];
  const disposed = [];
  let nextId = 200;
  const doc = { id: 7, name: "1645.heic", width: 1000, height: 800, layers: [], activeLayers: [] };
  doc.selection = {
    bounds: null,
    deselect() {
      calls.push(["deselect"]);
      this.bounds = null;
    },
  };
  function makeLayer(id, name, bounds) {
    return {
      id,
      name,
      kind,
      visible: true,
      bounds: { ...bounds },
      async duplicate() {
        calls.push(["duplicate", id]);
        const l = makeLayer(nextId++, `${this.name} copy`, this.bounds);
        doc.layers.splice(doc.layers.indexOf(this), 0, l);
        doc.activeLayers = [l];
        return l;
      },
    };
  }
  const pasted = makeLayer(30, "Mushroom", { left: 100, top: 100, right: 300, bottom: 200 });
  doc.layers = [pasted, makeLayer(20, "Background", { left: 0, top: 0, right: 1000, bottom: 800 })];
  doc.activeLayers = [doc.layers[1]];

  const other = { id: 8, name: "other.psd", layers: [], activeLayers: [] };
  const ps = {
    calls,
    disposed,
    doc,
    other,
    pasted,
    app: { documents: [doc, other], activeDocument: otherActive ? other : doc },
    core: {
      async executeAsModal(fn, options) {
        calls.push(["executeAsModal", options.commandName]);
        return fn({
          hostControl: {
            async suspendHistory(o) {
              calls.push(["suspendHistory", o]);
              return 1;
            },
            async resumeHistory(id, commit) {
              calls.push(["resumeHistory", id, commit]);
            },
          },
        });
      },
    },
    imaging: {
      async getPixels(opts) {
        calls.push(["getPixels", opts]);
        const isLayer = opts.layerID !== undefined;
        const sb = opts.sourceBounds;
        const w = opts.targetSize ? opts.targetSize.width : sb.right - sb.left;
        const h = 2;
        const components = isLayer ? 4 : refComponents;
        const imageData = {
          width: w,
          height: h,
          components,
          async getData() {
            const buf = new Uint8Array(w * h * components);
            for (let i = 0; i < w * h; i++) {
              const p = isLayer ? (layerPixels ? layerPixels[i % layerPixels.length] : [100, 100, 100, 255]) : refPixel;
              buf.set(p.slice(0, components), i * components);
            }
            return buf;
          },
          dispose() {
            disposed.push(isLayer ? "layer" : "composite");
          },
        };
        return { imageData };
      },
    },
    action: {
      async batchPlay(descs) {
        calls.push(["batchPlay", descs]);
        return descs.map((desc) => {
          if (desc._obj === "get") return { hasUserMask: hasMask };
          if (desc._obj === "select" && desc._target[0]._ref === "layer") {
            const l = doc.layers.find((x) => x.id === desc._target[0]._id);
            if (l) doc.activeLayers = [l];
          }
          if (desc._obj === "make" && desc._target && desc._target[0]._ref === "adjustmentLayer") {
            const l = makeLayer(nextId++, desc.using.name, { left: 0, top: 0, right: 1000, bottom: 800 });
            l.isClippingMask = desc.using.name === preClipped;
            doc.layers.splice(doc.layers.indexOf(doc.activeLayers[0]), 0, l);
            doc.activeLayers = [l];
          }
          if (desc._obj === "groupEvent") doc.activeLayers[0].isClippingMask = true;
          if (desc._obj === "newPlacedLayer") {
            const l = doc.activeLayers[0];
            l.id = nextId++;
            l.kind = "smartObject";
          }
          return {};
        });
      },
    },
  };
  return ps;
}

const finishDescs = (ps) =>
  ps.calls.filter((c) => c[0] === "batchPlay").flatMap((c) => c[1]).map(strip).filter((d) => d._obj !== "get");
const loadTransparency = {
  _obj: "set",
  _target: [{ _ref: "channel", _property: "selection" }],
  to: { _ref: "channel", _enum: "channel", _value: "transparencyEnum" },
};
const deleteMask = { _obj: "delete", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }] };

test("refine_edge orders contract before feather and replaces an existing mask", async () => {
  const ps = makeFinishStub({ hasMask: true });
  const res = await composite.refine_edge(ps, { doc: 7, layer: 30, contract_px: 2, feather_px: 1.5 });
  assert.deepEqual(res, { ok: true, warnings: [] });
  assert.deepEqual(suspends(ps), [{ documentID: 7, name: "Claude: refine_edge, contract 2 feather 1.5" }]);
  assert.deepEqual(finishDescs(ps), [
    D.selectLayerById(30),
    deleteMask,
    loadTransparency,
    D.contract(2),
    D.feather(1.5),
    D.makeMaskFromSelection("reveal"),
  ]);
  assert.ok(ps.calls.some((c) => c[0] === "deselect"));
});

test("refine_edge skips zero contract/feather descriptors and keeps no mask to delete", async () => {
  const ps = makeFinishStub();
  await composite.refine_edge(ps, { doc: 7, layer: 30, contract_px: 0, feather_px: 0 });
  assert.deepEqual(finishDescs(ps), [D.selectLayerById(30), loadTransparency, D.makeMaskFromSelection("reveal")]);
});

test("refine_edge rejects a missing layer or negative numbers before any step", async () => {
  const ps = makeFinishStub();
  await assert.rejects(composite.refine_edge(ps, { doc: 7, layer: 99, contract_px: 1, feather_px: 1 }), (e) => e.code === "NO_LAYER");
  await assert.rejects(
    composite.refine_edge(ps, { doc: 7, layer: 30, contract_px: -1, feather_px: 1 }),
    (e) => e.code === "INVALID_ARGS",
  );
  await assert.rejects(
    composite.refine_edge(ps, { doc: 7, layer: 30, contract_px: 1, feather_px: "2" }),
    (e) => e.code === "INVALID_ARGS",
  );
  assert.equal(modalCount(ps), 0);
});

test("refine_edge decontaminate warns and skips when defringe is not recorded", async () => {
  composite.setRecorded({ defringe: null });
  try {
    const ps = makeFinishStub();
    const res = await composite.refine_edge(ps, { doc: 7, layer: 30, contract_px: 1, feather_px: 1, decontaminate: true });
    assert.deepEqual(res, { ok: true, warnings: ["defringe not recorded; skipped"] });
    assert.ok(!ps.calls.some((c) => c[0] === "duplicate"));
    assert.equal(ps.pasted.visible, true);
  } finally {
    composite.setRecorded(null);
  }
});

test("refine_edge decontaminate defringes a duplicate at width 1 and hides the original", async () => {
  composite.setRecorded({ defringe: { _obj: "defringe", width: { _unit: "pixelsUnit", _value: 3 } } });
  try {
    const ps = makeFinishStub();
    const res = await composite.refine_edge(ps, { doc: 7, layer: 30, contract_px: 1, feather_px: 1, decontaminate: true });
    const dup = ps.doc.layers[0];
    assert.equal(dup.name, "Mushroom decontaminated");
    assert.deepEqual(res, { ok: true, warnings: [], decontaminated_layer_id: dup.id });
    assert.equal(ps.pasted.visible, false);
    assert.deepEqual(ps.doc.layers.map((l) => l.id), [dup.id, 30, 20]);
    assert.deepEqual(finishDescs(ps).slice(-2), [
      D.selectLayerById(dup.id),
      { _obj: "defringe", width: { _unit: "pixelsUnit", _value: 1 } },
    ]);
    assert.equal(suspends(ps).length, 1);
  } finally {
    composite.setRecorded(null);
  }
});

test("match_tone computes lightness from means", async () => {
  const ps = makeFinishStub();
  const ref = { left: 500, top: 400, right: 600, bottom: 500 };
  const res = await composite.match_tone(ps, { doc: 7, layer: 30, reference_bbox: ref });
  const [hueSat, curves] = ps.doc.layers;
  assert.deepEqual(res, {
    hue: 0,
    saturation: 0,
    lightness: 16,
    curve: [[0, 0], [128, 138], [255, 255]],
    layer_ids: { hue_sat: hueSat.id, curves: curves.id },
  });
  // stats read in a read modal before the one history step
  assert.deepEqual(ps.calls.filter((c) => c[0] === "executeAsModal").map((c) => c[1]), [
    "Match Tone Stats",
    "Claude: match_tone, L 16 S 0",
  ]);
  assert.deepEqual(suspends(ps), [{ documentID: 7, name: "Claude: match_tone, L 16 S 0" }]);
  const [layerRead, refRead] = ps.calls.filter((c) => c[0] === "getPixels").map((c) => c[1]);
  assert.deepEqual(layerRead, {
    documentID: 7,
    layerID: 30,
    sourceBounds: { left: 100, top: 100, right: 300, bottom: 200 },
    targetSize: { width: 200 },
    componentSize: 8,
    applyAlpha: false,
  });
  assert.equal(refRead.layerID, undefined);
  assert.equal(refRead.applyAlpha, true);
  assert.deepEqual(refRead.sourceBounds, ref);
  assert.deepEqual(ps.disposed.sort(), ["composite", "layer"]);
  assert.deepEqual(finishDescs(ps), [
    D.selectLayerById(30),
    ...D.makeAdjustment("hue_sat", { hue: 0, saturation: 0, lightness: 16 }, "Match tone (HSL)"),
    D.selectLayerById(hueSat.id),
    D.clipToBelow(),
    D.selectLayerById(30),
    ...D.makeAdjustment("curves", { points: { rgb: [[0, 0], [128, 138], [255, 255]] } }, "Match tone (curve)"),
    D.selectLayerById(curves.id),
    D.clipToBelow(),
  ]);
  assert.deepEqual(ps.doc.layers.map((l) => l.name), ["Match tone (HSL)", "Match tone (curve)", "Mushroom", "Background"]);
});

test("match_tone ignores transparent pixels", async () => {
  // half the layer is transparent white; opaque pixels are grey 100
  const ps = makeFinishStub({ layerPixels: [[100, 100, 100, 255], [255, 255, 255, 0]] });
  const res = await composite.match_tone(ps, { doc: 7, layer: 30, reference_bbox: { left: 0, top: 0, right: 10, bottom: 10 } });
  assert.equal(res.lightness, 16);
});

test("match_tone computes saturation and clamps to +-40", async () => {
  // layer saturated red, reference grey: saturation drops, clamped at -40
  const ps = makeFinishStub({ layerPixels: [[200, 20, 20, 255]], refPixel: [255, 255, 255] });
  const res = await composite.match_tone(ps, { doc: 7, layer: 30, reference_bbox: { left: 0, top: 0, right: 10, bottom: 10 } });
  assert.equal(res.saturation, -40);
  assert.equal(res.lightness, 40);
  assert.equal(res.curve[1][1], 128 + Math.round((255 - (0.2126 * 200 + 0.7152 * 20 + 0.0722 * 20)) / 4));
});

test("match_tone rejects a missing layer, a bad bbox, and a fully transparent layer", async () => {
  const ps = makeFinishStub();
  const bbox = { left: 0, top: 0, right: 10, bottom: 10 };
  await assert.rejects(composite.match_tone(ps, { doc: 7, layer: 99, reference_bbox: bbox }), (e) => e.code === "NO_LAYER");
  await assert.rejects(
    composite.match_tone(ps, { doc: 7, layer: 30, reference_bbox: { left: 10, top: 0, right: 0, bottom: 10 } }),
    (e) => e.code === "INVALID_BBOX",
  );
  assert.equal(modalCount(ps), 0);
  const clear = makeFinishStub({ layerPixels: [[0, 0, 0, 0]] });
  await assert.rejects(composite.match_tone(clear, { doc: 7, layer: 30, reference_bbox: bbox }), (e) => e.code === "EMPTY_LAYER");
  assert.deepEqual(clear.disposed.sort(), ["composite", "layer"]);
  assert.equal(suspends(clear).length, 0);
});

test("blur_layer converts to smart object first", async () => {
  const ps = makeFinishStub({ otherActive: true });
  const res = await composite.blur_layer(ps, { doc: 7, layer: 30, radius_px: 1.2 });
  assert.deepEqual(finishDescs(ps), [D.selectLayerById(30), D.newPlacedLayer(), D.gaussianBlur(1.2)]);
  assert.deepEqual(suspends(ps), [{ documentID: 7, name: "Claude: blur_layer, 1.2 px" }]);
  assert.deepEqual(res, { ok: true, smart_object: true, layer_id: ps.pasted.id });
  assert.notEqual(res.layer_id, 30);
  // the document that was active before the call is active again
  assert.equal(ps.app.activeDocument, ps.other);
});

test("blur_layer does not re-wrap a layer that is already a smart object", async () => {
  const ps = makeFinishStub({ kind: "smartObject" });
  const res = await composite.blur_layer(ps, { doc: 7, layer: 30, radius_px: 2 });
  assert.deepEqual(finishDescs(ps), [D.selectLayerById(30), D.gaussianBlur(2)]);
  assert.equal(res.layer_id, 30);
});

test("blur_layer rejects radius outside 0.1..250 before any step", async () => {
  const ps = makeFinishStub();
  for (const radius_px of [0, 0.05, 251, "2"]) {
    await assert.rejects(composite.blur_layer(ps, { doc: 7, layer: 30, radius_px }), (e) => e.code === "INVALID_ARGS");
  }
  await assert.rejects(composite.blur_layer(ps, { doc: 7, layer: 99, radius_px: 2 }), (e) => e.code === "NO_LAYER");
  assert.equal(modalCount(ps), 0);
});

test("match_tone reads a 4-component reference by its alpha", async () => {
  // RGBA reference, opaque grey 140: a 3-component stride would misread it
  const ps = makeFinishStub({ refComponents: 4, refPixel: [140, 140, 140, 255] });
  const ref = { left: 0, top: 0, right: 10, bottom: 10 };
  const res = await composite.match_tone(ps, { doc: 7, layer: 30, reference_bbox: ref });
  assert.equal(res.lightness, 16);
  assert.equal(res.curve[1][1], 138);
});

test("match_tone does not re-clip a layer Photoshop already put in the clipping group", async () => {
  const ps = makeFinishStub({ preClipped: "Match tone (curve)" });
  const res = await composite.match_tone(ps, { doc: 7, layer: 30, reference_bbox: { left: 0, top: 0, right: 10, bottom: 10 } });
  const descs = finishDescs(ps);
  assert.equal(descs.filter((x) => x._obj === "groupEvent").length, 1);
  assert.ok(!descs.some((x, i) => x._obj === "groupEvent" && JSON.stringify(descs[i - 1]) === JSON.stringify(D.selectLayerById(res.layer_ids.curves))));
});

test("finishing tools restore the active document on failure", async () => {
  const ps = makeFinishStub({ otherActive: true });
  ps.action.batchPlay = async (descs) => descs.map(() => ({ _obj: "error", message: "boom" }));
  await assert.rejects(composite.blur_layer(ps, { doc: 7, layer: 30, radius_px: 2 }), (e) => e.code === "BATCHPLAY");
  assert.equal(ps.app.activeDocument, ps.other);
  const ps2 = makeFinishStub({ otherActive: true });
  await composite.refine_edge(ps2, { doc: 7, layer: 30, contract_px: 1, feather_px: 1 });
  assert.equal(ps2.app.activeDocument, ps2.other);
});
