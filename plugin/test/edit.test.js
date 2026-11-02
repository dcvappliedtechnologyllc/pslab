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
