const test = require("node:test");
const assert = require("node:assert/strict");
const edit = require("../lib/actions/edit");
const d = require("../lib/descriptors");
const { rasterizeStrokes, polygonMask } = require("../lib/raster");

const W = 40;
const H = 30;

// Stub ps: executeAsModal runs the callback with a recording hostControl;
// batchPlay records descriptors, and a `make` of a layer adds a layer to the
// document and makes it active (as Photoshop does); imaging records mask I/O.
function makeStub({ bits = 8, masks = {}, maskBuffers = {} } = {}) {
  const calls = [];
  let nextId = 100;
  const layer = (id, name) => ({ id, name, opacity: 100, blendMode: "normal", visible: true });
  const doc = {
    id: 1,
    name: "a.psd",
    width: W,
    height: H,
    bitsPerChannel: bits,
    layers: [layer(10, "Background"), layer(11, "Glare fix")],
    activeLayers: [],
  };
  doc.activeLayers = [doc.layers[1]];
  const other = { id: 2, name: "b.psd", width: W, height: H, bitsPerChannel: 8, layers: [], activeLayers: [] };
  let active = doc;
  const ps = {
    calls,
    doc,
    other,
    app: {
      documents: [doc, other],
      get activeDocument() {
        return active;
      },
      set activeDocument(v) {
        calls.push(["activate", v.id]);
        active = v;
      },
    },
    constants: { BlendMode: { NORMAL: "normal", MULTIPLY: "multiply", SOFTLIGHT: "softLight" } },
    core: {
      async executeAsModal(fn, options) {
        calls.push(["executeAsModal", options.commandName]);
        return fn({
          hostControl: {
            async suspendHistory(o) {
              calls.push(["suspendHistory", o]);
              return 7;
            },
            async resumeHistory(id, commit) {
              calls.push(["resumeHistory", id, commit]);
            },
          },
        });
      },
    },
    action: {
      async batchPlay(descs) {
        calls.push(["batchPlay", descs]);
        return descs.map((desc) => {
          if (desc._obj === "get") {
            const id = desc._target[1]._id;
            return { hasUserMask: !!masks[id] };
          }
          if (desc._obj === "make" && desc._target && ["adjustmentLayer", "layer", "layerSection"].includes(desc._target[0]._ref)) {
            const l = layer(nextId++, (desc.using && desc.using.name) || "Layer");
            active.layers.push(l);
            active.activeLayers = [l];
          }
          return {};
        });
      },
    },
    imaging: {
      async getLayerMask(o) {
        calls.push(["getLayerMask", o]);
        const buf = maskBuffers[o.layerID];
        const imageData = {
          width: W,
          height: H,
          components: 1,
          async getData(g) {
            calls.push(["getData", g]);
            return buf;
          },
          dispose() {
            calls.push(["dispose", "mask"]);
          },
        };
        return { imageData, sourceBounds: o.sourceBounds };
      },
      async createImageDataFromBuffer(buf, opts) {
        calls.push(["createImageDataFromBuffer", opts]);
        return {
          buf,
          opts,
          dispose() {
            calls.push(["dispose", "put"]);
          },
        };
      },
      async putLayerMask(o) {
        calls.push(["putLayerMask", o]);
      },
    },
  };
  return ps;
}

const bpCalls = (ps) => ps.calls.filter((c) => c[0] === "batchPlay").map((c) => c[1]);
const allDescs = (ps) => bpCalls(ps).flat().filter((x) => x._obj !== "get");
const strip = (desc) => {
  const { _options, ...rest } = desc;
  return rest;
};
const historyName = (ps) => ps.calls.find((c) => c[0] === "suspendHistory")[1].name;
const modalCount = (ps) => ps.calls.filter((c) => c[0] === "executeAsModal").length;

// ---------- add_adjustment ----------

test("unknown type leaves history untouched", async () => {
  const ps = makeStub();
  await assert.rejects(edit.add_adjustment(ps, { type: "posterize", params: {} }), (e) => e.code === "NOT_SUPPORTED");
  assert.equal(modalCount(ps), 0);
  assert.equal(bpCalls(ps).length, 0);
});

test("clarity_dehaze and color_vibrance without a recording are NOT_SUPPORTED before any step", async () => {
  edit.setRecorded({ light: { unsupported: true }, clarity_dehaze: null, color_vibrance: { unsupported: true } });
  try {
    for (const type of ["clarity_dehaze", "color_vibrance"]) {
      const ps = makeStub();
      await assert.rejects(edit.add_adjustment(ps, { type, params: {} }), (e) => e.code === "NOT_SUPPORTED");
      assert.equal(modalCount(ps), 0);
    }
  } finally {
    edit.setRecorded(null);
  }
});

test("light on a 32-bit document is NOT_SUPPORTED with no step", async () => {
  for (const bits of [32, "bitDepth32"]) {
    const ps = makeStub({ bits });
    await assert.rejects(edit.add_adjustment(ps, { type: "light", params: { exposure: 1 } }), (e) => e.code === "NOT_SUPPORTED");
    assert.equal(modalCount(ps), 0);
  }
});

test("light fallback builds group with exposure and curves", async () => {
  edit.setRecorded({ light: { unsupported: true }, clarity_dehaze: null, color_vibrance: null });
  try {
    const ps = makeStub();
    const r = await edit.add_adjustment(ps, {
      type: "light",
      params: { exposure: 0.6, contrast: 10, highlights: -40, shadows: 20 },
    });
    assert.equal(historyName(ps), "Claude: add_adjustment light, exposure +0.6 contrast +10");
    assert.equal(r.layer_id, 100); // the group
    const descs = allDescs(ps).map(strip);
    assert.deepEqual(descs[0], { _obj: "make", _target: [{ _ref: "layerSection" }], using: { _obj: "layerSection", name: "Light" } });
    assert.deepEqual(descs.slice(1), [
      ...d.makeAdjustment("exposure", { exposure: 0.6 }),
      ...d.makeAdjustment("curves", {
        points: { rgb: [[0, 0], [64, 64 + 5 - 1.25], [192, 192 - 10 + 1.25], [255, 255 - 10]] },
      }),
    ]);
    assert.deepEqual(ps.calls.find((c) => c[0] === "resumeHistory"), ["resumeHistory", 7, true]);
  } finally {
    edit.setRecorded(null);
  }
});

test("light fallback curve clamps and uses the given group name", async () => {
  edit.setRecorded({ light: null, clarity_dehaze: null, color_vibrance: null });
  try {
    const ps = makeStub();
    await edit.add_adjustment(ps, { type: "light", params: { shadows: -100, highlights: 300, contrast: 100 }, name: "Glare light" });
    const descs = allDescs(ps).map(strip);
    assert.equal(descs[0].using.name, "Glare light");
    const curve = descs.find((x) => x._obj === "set").to.adjustment[0].curve.map((p) => [p.horizontal, p.vertical]);
    assert.deepEqual(curve, [[0, 25], [64, 26.5], [192, 255], [255, 255]]);
  } finally {
    edit.setRecorded(null);
  }
});

test("recorded descriptor gets params substituted along the recorded paths", async () => {
  const recorded = {
    make: {
      _obj: "make",
      _target: [{ _ref: "adjustmentLayer" }],
      using: { _obj: "adjustmentLayer", type: { _obj: "clarityDehaze", clarity: 0, dehaze: { _unit: "percentUnit", _value: 0 } } },
    },
    fields: { clarity: "make.using.type.clarity", dehaze: "make.using.type.dehaze" },
  };
  edit.setRecorded({ light: null, clarity_dehaze: recorded, color_vibrance: null });
  try {
    const ps = makeStub();
    const r = await edit.add_adjustment(ps, { type: "clarity_dehaze", params: { clarity: 30, dehaze: -12 } });
    assert.equal(r.layer_id, 100);
    assert.equal(historyName(ps), "Claude: add_adjustment clarity_dehaze, clarity +30 dehaze -12");
    const [make] = allDescs(ps).map(strip);
    assert.equal(make.using.type.clarity, 30);
    assert.deepEqual(make.using.type.dehaze, { _unit: "percentUnit", _value: -12 });
    assert.equal(recorded.make.using.type.clarity, 0, "recorded template not mutated");
  } finally {
    edit.setRecorded(null);
  }
});

test("applyParams rejects malformed recordings with RECORDED_INVALID", () => {
  const bad = [
    { fields: {} },
    { make: { _obj: "make" }, fields: { a: 5 } },
    { make: { _obj: "make" }, fields: { a: "nowhere.x" } },
    { make: { _obj: "make", using: {} }, fields: { a: "make.missing.deep" } },
    { make: { _obj: "make" }, set: "x", fields: {} },
    { make: { _obj: "make", using: { exposure: 0 } }, fields: { a: "make.using.exposre" } },
  ];
  for (const rec of bad) {
    assert.throws(() => edit.applyParams(rec, { a: 1 }), (e) => e.code === "RECORDED_INVALID", JSON.stringify(rec));
  }
  const ok = edit.applyParams(
    { make: { _obj: "make", using: { v: 1 } }, set: { _obj: "set", to: { list: [{ c: 0 }] } }, fields: { v: "make.using.v", c: "set.to.list.0.c" } },
    { c: 4 },
  );
  assert.deepEqual(ok, [{ _obj: "make", using: { v: 0 } }, { _obj: "set", to: { list: [{ c: 4 }] } }]);
});

test("curves above a layer, clipped and renamed, in one step", async () => {
  const ps = makeStub();
  const points = { rgb: [[0, 0], [128, 121], [255, 255]] };
  const r = await edit.add_adjustment(ps, { type: "curves", params: { points }, above: 11, clip_to: 11, name: "Tone" });
  assert.equal(r.layer_id, 100);
  assert.equal(modalCount(ps), 1);
  assert.equal(historyName(ps), "Claude: add_adjustment curves, rgb 3 points");
  assert.deepEqual(allDescs(ps).map(strip), [
    d.selectLayerById(11),
    ...d.makeAdjustment("curves", { points }),
    d.selectLayerById(100),
    d.clipToBelow(),
  ]);
  assert.equal(ps.doc.layers.find((l) => l.id === 100).name, "Tone");
});

test("add_adjustment with a missing above layer fails before any step", async () => {
  const ps = makeStub();
  await assert.rejects(edit.add_adjustment(ps, { type: "exposure", params: {}, above: 999 }), (e) => e.code === "NO_LAYER");
  assert.equal(modalCount(ps), 0);
});

test("add_adjustment on another document activates it first", async () => {
  const ps = makeStub();
  await edit.add_adjustment(ps, { doc: 2, type: "exposure", params: { exposure: -1.5 } });
  assert.equal(ps.calls.find((c) => c[0] === "suspendHistory")[1].documentID, 2);
  assert.deepEqual(ps.calls.find((c) => c[0] === "activate"), ["activate", 2]);
  assert.equal(historyName(ps), "Claude: add_adjustment exposure, exposure -1.5");
});

// ---------- add_pixel_layer ----------

test("add_pixel_layer makes a named layer and returns its id", async () => {
  const ps = makeStub();
  const r = await edit.add_pixel_layer(ps, { name: "Paint" });
  assert.deepEqual(r, { layer_id: 100 });
  assert.equal(historyName(ps), "Claude: add_pixel_layer, Paint");
  assert.deepEqual(allDescs(ps).map(strip), [{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: "Paint" } }]);
});

// ---------- masks ----------

test("mask_from_polygon writes 1-component grayscale", async () => {
  const ps = makeStub();
  const points = [{ x: 5, y: 5 }, { x: 30, y: 5 }, { x: 30, y: 20 }];
  const r = await edit.mask_from_polygon(ps, { layer: 11, points, feather_px: 2, invert: true });
  assert.deepEqual(r, { ok: true });
  assert.equal(historyName(ps), "Claude: mask_from_polygon, 3 points");
  const create = ps.calls.find((c) => c[0] === "createImageDataFromBuffer")[1];
  assert.equal(create.components, 1);
  assert.equal(create.colorSpace, "Grayscale");
  assert.equal(create.width, W);
  assert.equal(create.height, H);
  const put = ps.calls.find((c) => c[0] === "putLayerMask")[1];
  assert.equal(put.layerID, 11);
  assert.equal(put.documentID, 1);
  assert.equal(put.kind, "user");
  assert.equal(put.replace, true);
  assert.deepEqual(put.imageData.buf, polygonMask(W, H, points, 2, true));
  assert.ok(ps.calls.some((c) => c[0] === "dispose" && c[1] === "put"));
});

test("mask_from_polygon rejects too few points and unknown layers before any step", async () => {
  const ps = makeStub();
  await assert.rejects(edit.mask_from_polygon(ps, { layer: 11, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], feather_px: 0 }), (e) => e.code === "INVALID_POLYGON");
  await assert.rejects(edit.mask_from_polygon(ps, { layer: 55, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }], feather_px: 0 }), (e) => e.code === "NO_LAYER" && /No layer with id 55/.test(e.message));
  assert.equal(modalCount(ps), 0);
});

test("mask_from_subject selects, masks, then deselects", async () => {
  const bbox = { left: 2, top: 3, right: 20, bottom: 25 };
  for (const mode of ["subject", "object"]) {
    const ps = makeStub();
    assert.deepEqual(await edit.mask_from_subject(ps, { layer: 11, bbox, mode }), { ok: true });
    assert.equal(historyName(ps), `Claude: mask_from_subject, ${mode}`);
    assert.deepEqual(allDescs(ps).map(strip), [
      d.selectLayerById(11),
      d.selectRectangle(bbox),
      mode === "subject" ? d.selectSubject() : d.objectSelect(bbox),
      d.makeMaskFromSelection("reveal"),
      { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } },
    ]);
  }
});

test("paint_mask composites on existing mask", async () => {
  const base = new Uint8Array(W * H).fill(0);
  const ps = makeStub({ masks: { 11: true }, maskBuffers: { 11: base } });
  const strokes = [{ points: [{ x: 10, y: 10 }, { x: 20, y: 10 }], size_px: 6, hardness: 1, opacity: 1 }];
  const r = await edit.paint_mask(ps, { layer: 11, strokes, color: "white" });
  assert.deepEqual(r, { ok: true, strokes: 1 });
  assert.equal(historyName(ps), "Claude: paint_mask, 1 strokes");
  const get = ps.calls.find((c) => c[0] === "getLayerMask")[1];
  assert.deepEqual({ ...get }, { documentID: 1, layerID: 11, kind: "user", sourceBounds: { left: 0, top: 0, right: W, bottom: H } });
  const out = ps.calls.find((c) => c[0] === "putLayerMask")[1].imageData.buf;
  assert.deepEqual(out, rasterizeStrokes(W, H, strokes, "white", base));
  let changed = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const inStroke = x >= 6 && x <= 23 && y >= 6 && y <= 13;
      if (!inStroke) assert.equal(out[i], 0, `pixel ${x},${y} outside the stroke changed`);
      if (out[i] !== 0) changed++;
    }
  }
  assert.ok(changed > 50);
  assert.equal(out[10 * W + 15], 255);
  const disposals = ps.calls.filter((c) => c[0] === "dispose").map((c) => c[1]);
  assert.deepEqual(disposals.sort(), ["mask", "put"]);
});

test("paint_mask without a mask starts from white", async () => {
  const ps = makeStub();
  const strokes = [{ points: [{ x: 5, y: 5 }], size_px: 4, hardness: 0.5, opacity: 0.5 }];
  await edit.paint_mask(ps, { layer: 11, strokes, color: "black" });
  assert.equal(ps.calls.some((c) => c[0] === "getLayerMask"), false);
  const out = ps.calls.find((c) => c[0] === "putLayerMask")[1].imageData.buf;
  assert.deepEqual(out, rasterizeStrokes(W, H, strokes, "black", null));
  assert.equal(out[0], 255);
});

test("paint_mask rolls back and disposes when putLayerMask fails", async () => {
  const ps = makeStub();
  ps.imaging.putLayerMask = async () => {
    throw new Error("put failed");
  };
  await assert.rejects(
    edit.paint_mask(ps, { layer: 11, strokes: [{ points: [{ x: 5, y: 5 }], size_px: 4, hardness: 1, opacity: 1 }], color: "white" }),
    /put failed/,
  );
  assert.deepEqual(ps.calls.find((c) => c[0] === "resumeHistory"), ["resumeHistory", 7, false]);
  assert.ok(ps.calls.some((c) => c[0] === "dispose" && c[1] === "put"));
});

// ---------- set_layer ----------

test("set_layer sets DOM properties and inverts the mask", async () => {
  const ps = makeStub();
  const r = await edit.set_layer(ps, { layer: 11, opacity: 40, blend: "multiply", visible: false, name: "Sheen", mask_invert: true });
  assert.deepEqual(r, { ok: true });
  assert.equal(historyName(ps), "Claude: set_layer, opacity blend visible name mask_invert");
  const l = ps.doc.layers[1];
  assert.equal(l.opacity, 40);
  assert.equal(l.blendMode, "multiply");
  assert.equal(l.visible, false);
  assert.equal(l.name, "Sheen");
  assert.deepEqual(allDescs(ps).map(strip), [d.selectLayerById(11), d.selectMaskChannel(), d.invert(), d.selectRgbChannel()]);
});

test("set_layer validation errors happen before any step", async () => {
  const ps = makeStub();
  await assert.rejects(edit.set_layer(ps, { layer: 11, blend: "sparkle" }), (e) => e.code === "INVALID_BLEND");
  await assert.rejects(edit.set_layer(ps, { layer: 99, opacity: 5 }), (e) => e.code === "NO_LAYER" && e.message === "No layer with id 99");
  await assert.rejects(edit.set_layer(ps, { layer: 11 }), (e) => e.code === "NOTHING_TO_CHANGE");
  assert.equal(modalCount(ps), 0);
  assert.equal(ps.doc.layers[1].blendMode, "normal");
});

test("add_adjustment rejects above and clip_to naming different layers before any step", async () => {
  const ps = makeStub();
  await assert.rejects(
    edit.add_adjustment(ps, { type: "exposure", params: {}, above: 10, clip_to: 11 }),
    (e) => e.code === "INVALID_ARGS" && /above/.test(e.message) && /clip_to/.test(e.message),
  );
  assert.equal(modalCount(ps), 0);
});

test("paint_mask fails without writing when the mask query fails", async () => {
  const ps = makeStub({ masks: { 11: true }, maskBuffers: { 11: new Uint8Array(W * H) } });
  const real = ps.action.batchPlay;
  ps.action.batchPlay = async (descs, o) => {
    if (descs.some((x) => x._obj === "get")) throw new Error("get failed");
    return real(descs, o);
  };
  await assert.rejects(
    edit.paint_mask(ps, { layer: 11, strokes: [{ points: [{ x: 5, y: 5 }], size_px: 4, hardness: 1, opacity: 1 }], color: "white" }),
    (e) => e.code === "MASK_QUERY_FAILED",
  );
  assert.equal(ps.calls.some((c) => c[0] === "putLayerMask"), false);
  assert.deepEqual(ps.calls.find((c) => c[0] === "resumeHistory"), ["resumeHistory", 7, false]);
});

test("mask and layer tools target doc, activate it for the step, then restore the active document", async () => {
  const cases = [
    ["mask_from_polygon", { layer: 20, points: [{ x: 1, y: 1 }, { x: 10, y: 1 }, { x: 5, y: 9 }], feather_px: 0 }],
    ["mask_from_subject", { layer: 20, bbox: { left: 0, top: 0, right: 10, bottom: 10 }, mode: "object" }],
    ["paint_mask", { layer: 20, strokes: [{ points: [{ x: 5, y: 5 }], size_px: 4, hardness: 1, opacity: 1 }], color: "black" }],
    ["set_layer", { layer: 20, opacity: 50, mask_invert: true }],
  ];
  for (const [name, args] of cases) {
    const ps = makeStub();
    ps.other.layers = [{ id: 20, name: "Other layer", opacity: 100, blendMode: "normal", visible: true }];
    await edit[name](ps, { doc: 2, ...args });
    assert.equal(ps.calls.find((c) => c[0] === "suspendHistory")[1].documentID, 2, name);
    assert.deepEqual(ps.calls.filter((c) => c[0] === "activate").map((c) => c[1]), [2, 1], name);
    assert.equal(ps.app.activeDocument, ps.doc, name);
    const put = ps.calls.find((c) => c[0] === "putLayerMask");
    if (put) assert.equal(put[1].documentID, 2, name);
    // a layer that only exists in the active document is not found in doc 2
    const ps2 = makeStub();
    await assert.rejects(edit[name](ps2, { doc: 2, ...args, layer: 11 }), (e) => e.code === "NO_LAYER", name);
    await assert.rejects(edit[name](ps2, { doc: 9, ...args }), (e) => e.code === "NO_DOCUMENT", name);
    assert.equal(modalCount(ps2), 0, name);
  }
});

test("a failed step in another document still restores the active document", async () => {
  const ps = makeStub();
  ps.other.layers = [{ id: 20, name: "Other layer", opacity: 100, blendMode: "normal", visible: true }];
  ps.imaging.putLayerMask = async () => {
    throw new Error("put failed");
  };
  await assert.rejects(
    edit.mask_from_polygon(ps, { doc: 2, layer: 20, points: [{ x: 1, y: 1 }, { x: 10, y: 1 }, { x: 5, y: 9 }], feather_px: 0 }),
  );
  assert.equal(ps.app.activeDocument, ps.doc);
  assert.ok(ps.calls.some((c) => c[0] === "resumeHistory" && c[2] === false));
});

// ---------- delete_layer ----------

function withDelete(ps, layer) {
  layer.delete = async () => {
    ps.calls.push(["delete", layer.id]);
    const i = ps.doc.layers.indexOf(layer);
    if (i !== -1) ps.doc.layers.splice(i, 1);
  };
  return layer;
}

test("delete_layer deletes the layer in one named step and reports it", async () => {
  const ps = makeStub();
  withDelete(ps, ps.doc.layers[1]);
  const r = await edit.delete_layer(ps, { confirm: true, layer: 11 });
  assert.deepEqual(r, { ok: true, deleted: { id: 11, name: "Glare fix" } });
  assert.equal(modalCount(ps), 1);
  assert.equal(historyName(ps), "Claude: delete_layer, Glare fix");
  assert.ok(ps.calls.some((c) => c[0] === "delete" && c[1] === 11));
  assert.deepEqual(ps.doc.layers.map((l) => l.id), [10]);
  assert.deepEqual(ps.calls.find((c) => c[0] === "resumeHistory"), ["resumeHistory", 7, true]);
});

test("delete_layer refuses the Background layer and missing layers before any step", async () => {
  const ps = makeStub();
  ps.doc.layers[0].kind = "pixel"; // named "Background"
  await assert.rejects(edit.delete_layer(ps, { confirm: true, layer: 10 }), (e) => e.code === "PROTECTED_LAYER");
  const flagged = { id: 12, name: "Renamed bg", kind: "pixel", isBackgroundLayer: true };
  ps.doc.layers.push(flagged);
  await assert.rejects(edit.delete_layer(ps, { confirm: true, layer: 12 }), (e) => e.code === "PROTECTED_LAYER");
  await assert.rejects(edit.delete_layer(ps, { confirm: true, layer: 999 }), (e) => e.code === "NO_LAYER");
  assert.equal(modalCount(ps), 0);
});

test("delete_layer allows a group named Background and targets doc, restoring the active document", async () => {
  const ps = makeStub();
  const group = withDelete(ps, { id: 20, name: "Background", kind: "group" });
  ps.other.layers = [group];
  const r = await edit.delete_layer(ps, { confirm: true, doc: 2, layer: 20 });
  assert.deepEqual(r.deleted, { id: 20, name: "Background" });
  assert.equal(ps.calls.find((c) => c[0] === "suspendHistory")[1].documentID, 2);
  assert.deepEqual(ps.calls.filter((c) => c[0] === "activate").map((c) => c[1]), [2, 1]);
  assert.equal(ps.app.activeDocument, ps.doc);
});

test("delete_layer without confirm: true is CONFIRM_REQUIRED before any step", async () => {
  const ps = makeStub();
  withDelete(ps, ps.doc.layers[1]);
  for (const extra of [{}, { confirm: false }, { confirm: "true" }]) {
    await assert.rejects(edit.delete_layer(ps, { layer: 11, ...extra }), (e) => e.code === "CONFIRM_REQUIRED");
  }
  assert.equal(modalCount(ps), 0);
  assert.equal(ps.calls.some((c) => c[0] === "delete"), false);
});

test("delete_layer rolls back when the delete fails", async () => {
  const ps = makeStub();
  ps.doc.layers[1].delete = async () => {
    throw new Error("locked");
  };
  await assert.rejects(edit.delete_layer(ps, { confirm: true, layer: 11 }), /locked/);
  assert.deepEqual(ps.calls.find((c) => c[0] === "resumeHistory"), ["resumeHistory", 7, false]);
});

// ---------- set_adjustment ----------

function withKinds(ps, kinds, lightIds = []) {
  ps.doc.layers.push(...Object.entries(kinds).map(([id, kind]) => ({ id: Number(id), name: `L${id}`, kind })));
  const inner = ps.action.batchPlay;
  ps.action.batchPlay = async (descs, opts) => {
    if (descs.every((x) => x._obj === "get" && x._target[0]._property === "adjustment")) {
      ps.calls.push(["kindGet", descs.map((x) => x._target[1]._id)]);
      return descs.map((x) => ({
        adjustment: [{ brightnessMode: { _value: lightIds.includes(x._target[1]._id) ? "brightnessModeLight" : "brightnessModeLegacy" } }],
      }));
    }
    return inner(descs, opts);
  };
  return ps;
}

test("set_adjustment curves selects the layer and sets it in one named step", async () => {
  const ps = withKinds(makeStub(), { 30: "curves" });
  const points = { rgb: [[0, 0], [128, 140], [255, 255]] };
  const r = await edit.set_adjustment(ps, { layer: 30, type: "curves", params: { points } });
  assert.deepEqual(r, { ok: true, applied: { points } });
  assert.equal(modalCount(ps), 1);
  assert.equal(historyName(ps), "Claude: set_adjustment curves, rgb 3 points");
  assert.deepEqual(allDescs(ps).map(strip), [d.selectLayerById(30), d.setAdjustment("curves", { points })]);
});

test("set_adjustment exposure and hue_sat use setAdjustment payloads", async () => {
  const ps = withKinds(makeStub(), { 31: "exposure", 32: "hueSaturation" });
  await edit.set_adjustment(ps, { layer: 31, type: "exposure", params: { exposure: 0.4, gamma: 1.1 } });
  await edit.set_adjustment(ps, { layer: 32, type: "hue_sat", params: { saturation: -20 } });
  const descs = allDescs(ps).map(strip);
  assert.deepEqual(descs, [
    d.selectLayerById(31), d.setAdjustment("exposure", { exposure: 0.4, gamma: 1.1 }),
    d.selectLayerById(32), d.setAdjustment("hue_sat", { saturation: -20 }),
  ]);
  const names = ps.calls.filter((c) => c[0] === "suspendHistory").map((c) => c[1].name);
  assert.deepEqual(names, ["Claude: set_adjustment exposure, exposure +0.4 gamma +1.1", "Claude: set_adjustment hue_sat, saturation -20"]);
});

test("set_adjustment light uses only the recorded set descriptor", async () => {
  const ps = withKinds(makeStub(), { 33: "brightnessContrast" }, [33]);
  await edit.set_adjustment(ps, { layer: 33, type: "light", params: { exposure: 0.3, highlights: -40 } });
  const descs = allDescs(ps).map(strip);
  assert.equal(descs.length, 2);
  assert.deepEqual(descs[0], d.selectLayerById(33));
  assert.equal(descs[1]._obj, "set");
  assert.equal(descs[1].to.brightnessExposure, 0.3);
  assert.equal(descs[1].to.brightnessHighlights, -40);
  assert.equal(descs[1].to.center, 0);
  assert.equal(historyName(ps), "Claude: set_adjustment light, exposure +0.3 highlights -40");
});

test("set_adjustment refuses wrong layers before any step", async () => {
  const ps = withKinds(makeStub(), { 40: "pixel", 41: "group", 42: "smartObject", 43: "curves", 44: "brightnessContrast", 45: "brightnessContrast" }, [44]);
  for (const id of [40, 41, 42]) {
    await assert.rejects(edit.set_adjustment(ps, { layer: id, type: "curves", params: {} }), (e) => e.code === "NOT_ADJUSTMENT");
  }
  await assert.rejects(edit.set_adjustment(ps, { layer: 43, type: "exposure", params: {} }), (e) => e.code === "TYPE_MISMATCH");
  // a Light layer is not a legacy brightness/contrast layer, and the reverse
  await assert.rejects(edit.set_adjustment(ps, { layer: 44, type: "brightness_contrast", params: {} }), (e) => e.code === "TYPE_MISMATCH");
  await assert.rejects(edit.set_adjustment(ps, { layer: 45, type: "light", params: {} }), (e) => e.code === "TYPE_MISMATCH");
  await assert.rejects(edit.set_adjustment(ps, { layer: 999, type: "curves", params: {} }), (e) => e.code === "NO_LAYER");
  await assert.rejects(edit.set_adjustment(ps, { layer: 43, type: "posterize", params: {} }), (e) => e.code === "NOT_SUPPORTED");
  assert.equal(modalCount(ps), 0);
});

test("set_adjustment recorded type without a recording is NOT_SUPPORTED before any step", async () => {
  edit.setRecorded({ light: null, clarity_dehaze: { unsupported: true }, color_vibrance: null });
  try {
    const ps = withKinds(makeStub(), { 50: "clarity", 51: "vibrance" });
    await assert.rejects(edit.set_adjustment(ps, { layer: 50, type: "clarity_dehaze", params: {} }), (e) => e.code === "NOT_SUPPORTED");
    await assert.rejects(edit.set_adjustment(ps, { layer: 51, type: "color_vibrance", params: {} }), (e) => e.code === "NOT_SUPPORTED");
    assert.equal(modalCount(ps), 0);
  } finally {
    edit.setRecorded(null);
  }
});

test("set_adjustment targets doc and restores the active document", async () => {
  const ps = makeStub();
  ps.other.layers = [{ id: 60, name: "Curves", kind: "curves" }];
  await edit.set_adjustment(ps, { doc: 2, layer: 60, type: "curves", params: {} });
  assert.equal(ps.calls.find((c) => c[0] === "suspendHistory")[1].documentID, 2);
  assert.deepEqual(ps.calls.filter((c) => c[0] === "activate").map((c) => c[1]), [2, 1]);
  assert.equal(ps.app.activeDocument, ps.doc);
});

test("set_adjustment on a layer whose kind cannot be read says unknown layer kind", async () => {
  const ps = withKinds(makeStub(), { 46: "" });
  await assert.rejects(
    edit.set_adjustment(ps, { layer: 46, type: "curves", params: {} }),
    (e) => e.code === "TYPE_MISMATCH" && /unknown layer kind/.test(e.message),
  );
  assert.equal(modalCount(ps), 0);
});

// ---------- levels ----------

test("add_adjustment levels makes the layer and sets it in one named step", async () => {
  const ps = makeStub();
  const params = { rgb: { in_white: 240, gamma: 1.2 }, blue: { in_white: 230 } };
  const r = await edit.add_adjustment(ps, { type: "levels", params, name: "Lift" });
  assert.equal(r.layer_id, 100);
  assert.equal(modalCount(ps), 1);
  assert.equal(historyName(ps), "Claude: add_adjustment levels, rgb 0 1.2 240 blue 0 1 230");
  assert.deepEqual(allDescs(ps).map(strip), d.makeAdjustment("levels", params));
  assert.equal(ps.doc.layers.find((l) => l.id === 100).name, "Lift");
});

test("levels params are validated before any step", async () => {
  const bad = [
    { rgb: { in_black: 200, in_white: 100 } },
    { rgb: { in_black: 255 } }, // equals the default in_white
    { red: { out_black: 200, out_white: 100 } },
    { green: { gamma: 0.05 } },
    { green: { gamma: 10 } },
    { blue: { in_white: 256 } },
    { blue: { in_white: 200.5 } },
    { alpha: { in_white: 200 } },
    { rgb: { in_whte: 200 } },
    { rgb: 5 },
  ];
  for (const params of bad) {
    const ps = withKinds(makeStub(), { 70: "levels" });
    await assert.rejects(edit.add_adjustment(ps, { type: "levels", params }), (e) => e.code === "INVALID_ARGS", JSON.stringify(params));
    await assert.rejects(edit.set_adjustment(ps, { layer: 70, type: "levels", params }), (e) => e.code === "INVALID_ARGS", JSON.stringify(params));
    assert.equal(modalCount(ps), 0);
  }
  const ok = makeStub();
  await edit.add_adjustment(ok, { type: "levels", params: { rgb: { in_black: 0, in_white: 1, out_black: 128, out_white: 128, gamma: 9.99 } } });
  assert.equal(modalCount(ok), 1);
});

test("set_adjustment levels edits a levels layer; other kinds are TYPE_MISMATCH", async () => {
  const ps = withKinds(makeStub(), { 71: "levels", 72: "curves" });
  const params = { red: { in_white: 250 }, green: { in_white: 240 } };
  const r = await edit.set_adjustment(ps, { layer: 71, type: "levels", params });
  assert.deepEqual(r, { ok: true, applied: params });
  assert.deepEqual(allDescs(ps).map(strip), [d.selectLayerById(71), d.setAdjustment("levels", params)]);
  assert.equal(historyName(ps), "Claude: set_adjustment levels, red 0 1 250 green 0 1 240");
  await assert.rejects(edit.set_adjustment(ps, { layer: 72, type: "levels", params }), (e) => e.code === "TYPE_MISMATCH");
  await assert.rejects(edit.set_adjustment(ps, { layer: 71, type: "curves", params: {} }), (e) => e.code === "TYPE_MISMATCH");
});

// ---------- white_balance ----------

test("whiteBalanceLevels lifts green and blue to the brightest channel", () => {
  assert.deepEqual(edit.whiteBalanceLevels({ r: 130, g: 118, b: 114 }), { red: 255, green: 231, blue: 224 });
  // a milder strength lands near the observed G 240 / B 232
  const mild = edit.whiteBalanceLevels({ r: 130, g: 118, b: 114 }, 0.7);
  assert.equal(mild.red, 255);
  assert.ok(mild.green >= 236 && mild.green <= 242, `green ${mild.green}`);
  assert.ok(mild.blue >= 228 && mild.blue <= 236, `blue ${mild.blue}`);
  // cool cast: blue brightest, red and green lifted
  assert.deepEqual(edit.whiteBalanceLevels({ r: 100, g: 110, b: 125 }), { red: 204, green: 224, blue: 255 });
  assert.deepEqual(edit.whiteBalanceLevels({ r: 1, g: 0, b: 0 }), { red: 255, green: 1, blue: 1 });
});

test("keep_warmth holds back only the red-blue gap on a warm cast; tint is always corrected", () => {
  // worked example: target_b = 130 - 0.5 * 16 = 122 -> B 238; G stays 231
  assert.deepEqual(edit.whiteBalanceLevels({ r: 130, g: 118, b: 114 }, 1, 0.5), { red: 255, green: 231, blue: 238 });
  // keep_warmth 1 leaves blue at its red-relative level: target_b = 114 -> 255
  assert.deepEqual(edit.whiteBalanceLevels({ r: 130, g: 118, b: 114 }, 1, 1), { red: 255, green: 231, blue: 255 });
  // strength still scales the held-back correction
  const half = edit.whiteBalanceLevels({ r: 130, g: 118, b: 114 }, 0.5, 0.5);
  assert.equal(half.blue, Math.round(238.28 + (255 - 238.28) * 0.5));
  // cool or neutral cast: keep_warmth ignored
  for (const mean of [{ r: 100, g: 110, b: 125 }, { r: 120, g: 110, b: 120 }]) {
    assert.deepEqual(edit.whiteBalanceLevels(mean, 1, 0.8), edit.whiteBalanceLevels(mean, 1, 0));
  }
});

// Reads return a flat patch; once a Levels layer is made, the composite is
// mapped through its per-channel in_white (as Photoshop would). A layer read
// (layerID set) always returns the base pixels.
function withPixels(ps, base) {
  let levels = null;
  const inner = ps.action.batchPlay;
  ps.action.batchPlay = async (descs, opts) => {
    for (const x of descs) {
      if (x._obj === "set" && x.to && x.to._obj === "levels") {
        levels = Object.fromEntries(x.to.adjustment.map((a) => [a.channel._value, a.input[1]]));
      }
    }
    return inner(descs, opts);
  };
  ps.imaging.getPixels = async (o) => {
    ps.calls.push(["getPixels", o]);
    const box = o.sourceBounds;
    const width = o.targetSize ? o.targetSize.width : box.right - box.left;
    const height = 2;
    const px = [base.r, base.g, base.b].map((v, i) => {
      const w = levels && o.layerID === undefined ? levels[["red", "grain", "blue"][i]] : 255;
      return Math.min(255, Math.round((v * 255) / w));
    });
    const data = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) data.set(px, i * 3);
    return { imageData: { width, height, components: 3, async getData() { return data; }, dispose() { ps.calls.push(["dispose", "pixels"]); } } };
  };
  return ps;
}

const withBackground = (ps) => {
  ps.doc.layers[0].isBackgroundLayer = true;
  ps.doc.layers[0].kind = "pixel";
  return ps;
};

test("white_balance measures the Background, adds one Levels layer above it, and measures the composite", async () => {
  const ps = withPixels(withBackground(makeStub()), { r: 130, g: 118, b: 114 });
  const bbox = { left: 2, top: 3, right: 20, bottom: 13 };
  const r = await edit.white_balance(ps, { bbox });
  assert.deepEqual(r.levels, { red: 255, green: 231, blue: 224 });
  assert.deepEqual(r.before, { r: 130, g: 118, b: 114 });
  for (const k of ["r", "g", "b"]) assert.ok(Math.abs(r.after[k] - 130) <= 1, `after ${k} ${r.after[k]}`);
  assert.equal(r.layer_id, 100);
  assert.equal(modalCount(ps), 3); // read, step, read
  const steps = ps.calls.filter((c) => c[0] === "suspendHistory");
  assert.equal(steps.length, 1);
  assert.equal(steps[0][1].name, "Claude: white_balance, R255 G231 B224");
  const params = { red: { in_white: 255 }, green: { in_white: 231 }, blue: { in_white: 224 } };
  assert.deepEqual(allDescs(ps).map(strip), [
    { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } },
    d.selectLayerById(10),
    ...d.makeAdjustment("levels", params, "White balance"),
  ]);
  const reads = ps.calls.filter((c) => c[0] === "getPixels").map((c) => c[1]);
  assert.equal(reads.length, 2);
  assert.equal(reads[0].layerID, 10, "before is the Background's own pixels");
  assert.equal(reads[1].layerID, undefined, "after is the composite");
  for (const o of reads) {
    assert.deepEqual(o.sourceBounds, bbox);
    assert.equal(o.targetSize, undefined);
  }
  assert.equal(ps.calls.filter((c) => c[0] === "dispose" && c[1] === "pixels").length, 2);
});

test("white_balance keep_warmth 0.5 matches the worked example", async () => {
  const ps = withPixels(withBackground(makeStub()), { r: 130, g: 118, b: 114 });
  const r = await edit.white_balance(ps, { bbox: { left: 0, top: 0, right: 10, bottom: 10 }, keep_warmth: 0.5 });
  assert.deepEqual(r.levels, { red: 255, green: 231, blue: 238 });
  assert.ok(Math.abs(r.after.g - 130) <= 1 && Math.abs(r.after.b - 122) <= 1, JSON.stringify(r.after));
});

test("white_balance without a Background anchors on the bottom-most layer and reads the composite", async () => {
  const ps = withPixels(makeStub(), { r: 130, g: 118, b: 114 });
  ps.doc.layers = [
    { id: 30, name: "Top", kind: "pixel" },
    { id: 31, name: "Bottom group", kind: "group" },
  ];
  await edit.white_balance(ps, { bbox: { left: 0, top: 0, right: 10, bottom: 10 } });
  assert.deepEqual(strip(allDescs(ps)[1]), d.selectLayerById(31));
  assert.equal(ps.calls.find((c) => c[0] === "getPixels")[1].layerID, undefined);
  // a bottom-most pixel layer is read on its own pixels
  const ps2 = withPixels(makeStub(), { r: 130, g: 118, b: 114 });
  ps2.doc.layers = [{ id: 40, name: "Top", kind: "curves" }, { id: 41, name: "Photo", kind: "pixel" }];
  await edit.white_balance(ps2, { bbox: { left: 0, top: 0, right: 10, bottom: 10 } });
  assert.deepEqual(strip(allDescs(ps2)[1]), d.selectLayerById(41));
  assert.equal(ps2.calls.find((c) => c[0] === "getPixels")[1].layerID, 41);
});

test("white_balance reads wide patches at 256 px, honours name/strength, and targets doc", async () => {
  const ps = withPixels(makeStub(), { r: 100, g: 110, b: 125 });
  ps.other.width = 1000;
  ps.other.height = 800;
  ps.other.layers = [{ id: 20, name: "Background", kind: "pixel", isBackgroundLayer: true }];
  const r = await edit.white_balance(ps, { doc: 2, bbox: { left: 0, top: 0, right: 900, bottom: 500 }, strength: 0.5, name: "WB wall" });
  assert.deepEqual(r.levels, edit.whiteBalanceLevels({ r: 100, g: 110, b: 125 }, 0.5));
  const first = ps.calls.find((c) => c[0] === "getPixels")[1];
  assert.deepEqual(first.targetSize, { width: 256 });
  assert.equal(first.documentID, 2);
  assert.equal(first.layerID, 20);
  assert.equal(ps.calls.find((c) => c[0] === "suspendHistory")[1].documentID, 2);
  assert.equal(allDescs(ps).find((x) => x._obj === "make").using.name, "WB wall");
  assert.equal(ps.app.activeDocument, ps.doc);
});

test("white_balance returns after: null when the re-measure fails", async () => {
  const ps = withPixels(withBackground(makeStub()), { r: 130, g: 118, b: 114 });
  const read = ps.imaging.getPixels;
  let n = 0;
  ps.imaging.getPixels = async (o) => {
    if (++n === 2) throw new Error("read failed");
    return read(o);
  };
  const r = await edit.white_balance(ps, { bbox: { left: 0, top: 0, right: 10, bottom: 10 } });
  assert.equal(r.after, null);
  assert.equal(r.layer_id, 100);
  assert.deepEqual(r.levels, { red: 255, green: 231, blue: 224 });
});

test("white_balance rejects bad args before any modal, and a black patch before any step", async () => {
  const ps = withPixels(withBackground(makeStub()), { r: 0, g: 0, b: 0 });
  const bbox = { left: 0, top: 0, right: 10, bottom: 10 };
  await assert.rejects(edit.white_balance(ps, {}), (e) => e.code === "INVALID_BBOX");
  await assert.rejects(edit.white_balance(ps, { bbox, strength: 1.5 }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(edit.white_balance(ps, { bbox, strength: 0 }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(edit.white_balance(ps, { bbox, keep_warmth: -0.1 }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(edit.white_balance(ps, { bbox: { left: 500, top: 500, right: 600, bottom: 600 } }), (e) => e.code === "EMPTY_REGION");
  await assert.rejects(edit.white_balance(ps, { doc: 9, bbox }), (e) => e.code === "NO_DOCUMENT");
  ps.doc.mode = "CMYKColorMode";
  await assert.rejects(edit.white_balance(ps, { bbox }), (e) => e.code === "UNSUPPORTED_MODE");
  assert.equal(modalCount(ps), 0);
  ps.doc.mode = "RGBColorMode";
  await assert.rejects(edit.white_balance(ps, { bbox }), (e) => e.code === "DARK_REGION");
  assert.equal(ps.calls.filter((c) => c[0] === "suspendHistory").length, 0);
});
