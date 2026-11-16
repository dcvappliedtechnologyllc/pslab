const test = require("node:test");
const assert = require("node:assert/strict");
const design = require("../lib/actions/design");
const recorded = require("../lib/recorded/index");

// Stub ps: batchPlay records descriptors; a select by id makes that layer
// active; a `make` of a contentLayer or layer adds a new layer on top and makes
// it active (opts.vectorFails turns the contentLayer make into an error entry);
// `get` answers from opts.gets[property] (a function of the layer id).
function makeStub(opts = {}) {
  const calls = [];
  const doc = { id: 1, name: "a.psd", width: 1000, height: 800, resolution: 350, layers: [], activeLayers: [] };
  const other = { id: 2, name: "b.psd", layers: [], activeLayers: [] };
  const byId = (id) => doc.layers.find((l) => l.id === id) || null;
  const mk = (id, name, extra = {}) => ({
    id,
    name,
    kind: "pixel",
    visible: true,
    opacity: 100,
    isClippingMask: false,
    boundsNoEffects: { left: 0, top: 0, right: 0, bottom: 0 },
    ...extra,
  });
  let nextId = 100;
  let active = other;
  const edges = (s) => ({ left: s.left._value, top: s.top._value, right: s.right._value, bottom: s.bottom._value });
  const ps = {
    calls,
    doc,
    other,
    byId,
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
    constants: { ElementPlacement: { PLACEBEFORE: "placeBefore", PLACEAFTER: "placeAfter" } },
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
        const out = [];
        for (const x of descs) {
          if (x._obj === "get") {
            const prop = x._target[0]._property;
            const id = x._target[1]._id;
            const answer = opts.gets && opts.gets[prop] ? opts.gets[prop](id) : {};
            out.push(answer);
            continue;
          }
          if (x._obj === "select" && x._target[0]._ref === "layer") doc.activeLayers = [byId(x._target[0]._id)];
          if (x._obj === "make" && x._target[0]._ref === "contentLayer") {
            if (opts.vectorFails) {
              out.push({ _obj: "error", message: "The command make is not currently available" });
              continue;
            }
            const l = mk(nextId++, "Rectangle 1", { kind: "solidColor", boundsNoEffects: edges(x.using.shape) });
            doc.layers.unshift(l);
            doc.activeLayers = [l];
          }
          if (x._obj === "make" && x._target[0]._ref === "layer") {
            const l = mk(nextId++, x.using.name || "Layer 1");
            doc.layers.unshift(l);
            doc.activeLayers = [l];
          }
          if (x._obj === "set" && x._target[0]._property === "selection" && x.to._obj && doc.activeLayers[0]) {
            // the stub fills the selection's box into the active pixel layer's bounds
            const t = x.to;
            if (t._obj === "polygon") {
              const xs = t.points.map((p) => p.horizontal._value);
              const ys = t.points.map((p) => p.vertical._value);
              doc.pendingBounds = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
            } else {
              doc.pendingBounds = edges(t);
            }
          }
          if (x._obj === "fill" && doc.pendingBounds) doc.activeLayers[0].boundsNoEffects = doc.pendingBounds;
          out.push({});
        }
        return out;
      },
    },
  };
  const title = mk(3, "Title", { kind: "text", boundsNoEffects: { left: 300, top: 100, right: 700, bottom: 200 } });
  const clipped = mk(4, "Clipped", { isClippingMask: true });
  const bg = mk(1, "Background", { isBackgroundLayer: true, boundsNoEffects: { left: 0, top: 0, right: 1000, bottom: 800 } });
  doc.layers.push(title, clipped, bg);
  doc.activeLayers = [title];
  return ps;
}

const strip = ({ _options, ...rest }) => rest;
const bpDescs = (ps) => ps.calls.filter((c) => c[0] === "batchPlay").flatMap((c) => c[1]);
const historyName = (ps) => (ps.calls.find((c) => c[0] === "suspendHistory") || [])[1]?.name;
const modalCount = (ps) => ps.calls.filter((c) => c[0] === "executeAsModal").length;
const committed = (ps) => ps.calls.filter((c) => c[0] === "resumeHistory").map((c) => c[2]);

const WHITE = { r: 255, g: 255, b: 255 };

// ---------- add_shape ----------

test("recorded index exposes the shape drafts, marked draft", () => {
  assert.equal(recorded.shape_rect.draft, true);
  assert.equal(recorded.shape_ellipse.draft, true);
  assert.equal(recorded.shape_ellipse.make.using.shape._obj, "ellipse");
  assert.equal(recorded.shape_rect.make.using.shape._obj, "rectangle");
});

test("add_shape rect: vector make with bbox and colour applied, named, one step", async () => {
  const ps = makeStub();
  const bbox = { left: 370, top: 220, right: 630, bottom: 228 };
  const r = await design.add_shape(ps, { doc: 1, kind: "rect", bbox, color: { r: 255, g: 128, b: 0 }, name: "Bar 1", opacity: 80, above: 3 });
  assert.deepEqual(r, { layer_id: 100, kind: "rect", vector: true, bounds: bbox });
  assert.equal(modalCount(ps), 1);
  assert.equal(historyName(ps), "Claude: add_shape, rect Bar 1");
  assert.deepEqual(committed(ps), [true]);
  const descs = bpDescs(ps);
  assert.deepEqual(descs[0]._target, [{ _ref: "layer", _id: 3 }], "anchor selected first");
  const make = descs[1];
  assert.equal(make._obj, "make");
  assert.deepEqual(make.using.type.color, { _obj: "RGBColor", red: 255, grain: 128, blue: 0 });
  assert.deepEqual(make.using.shape.top, { _unit: "pixelsUnit", _value: 220 });
  assert.deepEqual(make.using.shape.right, { _unit: "pixelsUnit", _value: 630 });
  assert.equal(descs.length, 2, "no transform for a rect");
  const layer = ps.byId(100);
  assert.equal(layer.name, "Bar 1");
  assert.equal(layer.opacity, 80);
  assert.equal(ps.app.activeDocument, ps.other, "active document restored");
  assert.equal(recorded.shape_rect.make.using.shape.top._value, 0, "template untouched");
});

test("add_shape ellipse uses the ellipse draft", async () => {
  const ps = makeStub();
  const bbox = { left: 10, top: 20, right: 110, bottom: 70 };
  const r = await design.add_shape(ps, { doc: 1, kind: "ellipse", bbox, color: WHITE, name: "Dot" });
  assert.equal(r.vector, true);
  assert.equal(bpDescs(ps)[0].using.shape._obj, "ellipse");
  assert.equal(ps.byId(100).opacity, 100, "opacity untouched when not given");
});

test("add_shape line: vector rect around the midpoint, then a free transform by the angle", async () => {
  const ps = makeStub();
  await design.add_shape(ps, { doc: 1, kind: "line", from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, thickness_px: 4, color: WHITE, name: "Diag" });
  const descs = bpDescs(ps);
  const make = descs[0];
  const w = make.using.shape.right._value - make.using.shape.left._value;
  assert.ok(Math.abs(w - Math.hypot(100, 100)) < 1e-9);
  assert.deepEqual(strip(descs[1]), { _obj: "select", _target: [{ _ref: "layer", _id: 100 }], makeVisible: false });
  assert.equal(descs[2]._obj, "transform");
  assert.ok(Math.abs(descs[2].angle._value - 45) < 1e-9);
  assert.equal(descs[2].width._value, 100);
});

test("add_shape horizontal line needs no transform", async () => {
  const ps = makeStub();
  const r = await design.add_shape(ps, { doc: 1, kind: "line", from: { x: 370, y: 224 }, to: { x: 630, y: 224 }, thickness_px: 8, color: WHITE, name: "Bar" });
  assert.deepEqual(r.bounds, { left: 370, top: 220, right: 630, bottom: 228 });
  assert.equal(bpDescs(ps).some((x) => x._obj === "transform"), false);
});

test("add_shape falls back to a raster fill when the vector make fails: vector false, one step", async () => {
  const ps = makeStub({ vectorFails: true });
  const bbox = { left: 370, top: 220, right: 630, bottom: 228 };
  const r = await design.add_shape(ps, { doc: 1, kind: "rect", bbox, color: { r: 10, g: 20, b: 30 }, name: "Bar 1", above: 4 });
  assert.deepEqual(r, { layer_id: 100, kind: "rect", vector: false, bounds: bbox });
  assert.equal(modalCount(ps), 1);
  assert.deepEqual(committed(ps), [true]);
  const objs = bpDescs(ps).map((x) => x._obj);
  assert.deepEqual(objs, ["select", "make", "make", "set", "fill", "set"]);
  const descs = bpDescs(ps);
  assert.deepEqual(descs[2].using, { _obj: "layer", name: "Bar 1" });
  assert.equal(descs[3].to._obj, "rectangle");
  assert.deepEqual(descs[4].color, { _obj: "RGBColor", red: 10, grain: 20, blue: 30 });
  assert.equal(descs[4].using._value, "color");
  assert.deepEqual(descs[5].to, { _enum: "ordinal", _value: "none" }, "deselected after the fill");
  const layer = ps.byId(100);
  assert.equal(layer.name, "Bar 1");
  assert.equal(layer.isClippingMask, false, "made above a clipped layer: released");
});

test("add_shape raster ellipse uses an ellipse selection; raster diagonal line a polygon", async () => {
  let ps = makeStub({ vectorFails: true });
  await design.add_shape(ps, { doc: 1, kind: "ellipse", bbox: { left: 0, top: 0, right: 10, bottom: 10 }, color: WHITE, name: "E" });
  const sel = bpDescs(ps).find((x) => x._obj === "set" && x.to._obj);
  assert.equal(sel.to._obj, "ellipse");
  assert.equal(sel.antiAlias, true);
  ps = makeStub({ vectorFails: true });
  const r = await design.add_shape(ps, { doc: 1, kind: "line", from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, thickness_px: 4, color: WHITE, name: "L" });
  const poly = bpDescs(ps).find((x) => x._obj === "set" && x.to._obj);
  assert.equal(poly.to._obj, "polygon");
  assert.equal(poly.to.points.length, 4);
  assert.equal(bpDescs(ps).some((x) => x._obj === "transform"), false, "raster lines are never resampled");
  assert.equal(r.vector, false);
});

test("add_shape uses the raster path when no shape descriptor is available", async () => {
  design.setRecorded({ shape_rect: null, shape_ellipse: { unsupported: true } });
  try {
    const ps = makeStub();
    const r = await design.add_shape(ps, { doc: 1, kind: "rect", bbox: { left: 0, top: 0, right: 5, bottom: 5 }, color: WHITE, name: "R" });
    assert.equal(r.vector, false);
    assert.equal(bpDescs(ps).some((x) => x._target && x._target[0]._ref === "contentLayer"), false);
  } finally {
    design.setRecorded(null);
  }
});

test("add_shape refuses bad arguments before any modal call", async () => {
  const ps = makeStub();
  const bbox = { left: 0, top: 0, right: 10, bottom: 10 };
  const ok = { doc: 1, kind: "rect", bbox, color: WHITE, name: "x" };
  const bad = [
    [{ ...ok, kind: "star" }, "INVALID_ARGS"],
    [{ ...ok, bbox: undefined }, "INVALID_ARGS"],
    [{ ...ok, bbox: { left: 10, top: 0, right: 5, bottom: 10 } }, "INVALID_ARGS"],
    [{ ...ok, color: { r: 256, g: 0, b: 0 } }, "INVALID_ARGS"],
    [{ ...ok, color: undefined }, "INVALID_ARGS"],
    [{ ...ok, name: "" }, "INVALID_ARGS"],
    [{ ...ok, opacity: 120 }, "INVALID_ARGS"],
    [{ ...ok, kind: "line", from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, thickness_px: 2 }, "INVALID_ARGS"],
    [{ ...ok, kind: "line", from: { x: 0, y: 0 }, to: { x: 5, y: 0 } }, "INVALID_ARGS"],
    [{ ...ok, above: 404 }, "NO_LAYER"],
    [{ ...ok, doc: 9 }, "NO_DOCUMENT"],
  ];
  for (const [args, code] of bad) {
    await assert.rejects(design.add_shape(ps, args), { code }, JSON.stringify(args));
  }
  assert.equal(modalCount(ps), 0);
});


// ---------- add_layer_style ----------

const pct = (v) => ({ _unit: "percentUnit", _value: v });
const pxu = (v) => ({ _unit: "pixelsUnit", _value: v });
const STROKE = { _obj: "frameFX", enabled: true, present: true, size: pxu(3) };
const effectsGet = (byLayer) => ({ layerEffects: (id) => (byLayer[id] ? { layerEffects: byLayer[id] } : {}) });
const styleSet = (ps) => bpDescs(ps).find((x) => x._obj === "set" && x._target[0]._property === "layerEffects");

test("add_layer_style drop_shadow: defaults, recorded set, scale from ppi, one step", async () => {
  const ps = makeStub({ gets: effectsGet({}) });
  const r = await design.add_layer_style(ps, { doc: 1, layer: 3, style: "drop_shadow" });
  assert.deepEqual(r, {
    ok: true, layer_id: 3, style: "drop_shadow",
    applied: { color: { r: 0, g: 0, b: 0 }, opacity: 35, angle: 120, distance_px: 6, spread_pct: 0, size_px: 10, blend: "multiply" },
  });
  assert.equal(modalCount(ps), 1);
  assert.equal(historyName(ps), "Claude: add_layer_style, drop_shadow Title");
  const get = bpDescs(ps)[0];
  assert.equal(get._obj, "get");
  assert.deepEqual(get._target[0], { _property: "layerEffects" });
  const descs = bpDescs(ps).slice(1);
  assert.deepEqual(strip(descs[0]), { _obj: "select", _target: [{ _ref: "layer", _id: 3 }], makeVisible: false });
  const set = descs[1];
  assert.ok(Math.abs(set.to.scale._value - 486.1111111111111) < 1e-9, "scale = 100 * 350 / 72");
  const ds = set.to.dropShadow;
  assert.deepEqual(ds.opacity, pct(35));
  assert.deepEqual(ds.localLightingAngle, { _unit: "angleUnit", _value: 120 });
  assert.deepEqual(ds.distance, pxu(6));
  assert.deepEqual(ds.chokeMatte, pxu(0));
  assert.deepEqual(ds.blur, pxu(10));
  assert.deepEqual(ds.color, { _obj: "RGBColor", red: 0, grain: 0, blue: 0 });
  assert.deepEqual(ds.mode, { _enum: "blendMode", _value: "multiply" });
  assert.equal(ds.useGlobalAngle, false);
  assert.equal(ds.enabled, true);
  assert.equal(ds.layerConceals, true, "recorded extras kept");
  assert.equal(recorded.drop_shadow.set.to.dropShadow.opacity._value, 40, "template untouched");
});

test("add_layer_style keeps an existing stroke and its scale, replaces an old shadow", async () => {
  const existing = { _obj: "layerEffects", scale: pct(300), frameFX: STROKE, dropShadow: { _obj: "dropShadow", opacity: pct(5) } };
  const ps = makeStub({ gets: effectsGet({ 3: existing }) });
  await design.add_layer_style(ps, {
    doc: 1, layer: 3, style: "drop_shadow",
    params: { color: { r: 20, g: 30, b: 40 }, opacity: 60, angle: 90, distance_px: 12, spread_pct: 10, size_px: 4, blend: "soft_light" },
  });
  const set = styleSet(ps);
  assert.deepEqual(set.to.frameFX, STROKE);
  assert.deepEqual(set.to.scale, pct(300));
  const ds = set.to.dropShadow;
  assert.deepEqual(ds.opacity, pct(60));
  assert.deepEqual(ds.color, { _obj: "RGBColor", red: 20, grain: 30, blue: 40 });
  assert.deepEqual(ds.chokeMatte, pxu(10));
  assert.deepEqual(ds.blur, pxu(4));
  assert.deepEqual(ds.distance, pxu(12));
  assert.equal(ds.localLightingAngle._value, 90);
  assert.equal(ds.mode._value, "softLight");
});

test("add_layer_style refuses bad params, the Background, unknown styles and a missing recording, before any modal call", async () => {
  const ps = makeStub({ gets: effectsGet({}) });
  const bad = [
    [{ doc: 1, layer: 3, style: "drop_shadow", params: { glow: 3 } }, "INVALID_ARGS"],
    [{ doc: 1, layer: 3, style: "drop_shadow", params: { opacity: 300 } }, "INVALID_ARGS"],
    [{ doc: 1, layer: 3, style: "bevel" }, "INVALID_ARGS"],
    [{ doc: 1, layer: 1, style: "drop_shadow" }, "PROTECTED_LAYER"],
    [{ doc: 1, layer: 404, style: "drop_shadow" }, "NO_LAYER"],
  ];
  for (const [args, code] of bad) await assert.rejects(design.add_layer_style(ps, args), { code }, JSON.stringify(args));
  design.setRecorded({ drop_shadow: null });
  try {
    await assert.rejects(design.add_layer_style(ps, { doc: 1, layer: 3, style: "drop_shadow" }), { code: "NOT_SUPPORTED" });
  } finally {
    design.setRecorded(null);
  }
  assert.equal(modalCount(ps), 0);
});

// ---------- set_layer_style ----------

const CURRENT_SHADOW = {
  _obj: "dropShadow",
  enabled: true,
  present: true,
  mode: { _enum: "blendMode", _value: "multiply" },
  color: { _obj: "RGBColor", red: 0, grain: 0, blue: 0 },
  opacity: pct(35),
  useGlobalAngle: false,
  localLightingAngle: { _unit: "angleUnit", _value: 120 },
  distance: pxu(6),
  chokeMatte: pxu(0),
  blur: pxu(10),
  noise: pct(7),
};

test("set_layer_style merges partial params over the current shadow, keeps the stroke", async () => {
  const existing = { _obj: "layerEffects", scale: pct(486.1111111111111), frameFX: STROKE, dropShadow: CURRENT_SHADOW };
  const ps = makeStub({ gets: effectsGet({ 3: existing }) });
  const r = await design.set_layer_style(ps, { doc: 1, layer: 3, style: "drop_shadow", params: { opacity: 60, size_px: 4 } });
  assert.deepEqual(r.applied, { color: { r: 0, g: 0, b: 0 }, opacity: 60, angle: 120, distance_px: 6, spread_pct: 0, size_px: 4, blend: "multiply" });
  assert.equal(r.enabled, true);
  assert.equal(modalCount(ps), 1);
  assert.equal(historyName(ps), "Claude: set_layer_style, drop_shadow opacity 60 size_px 4");
  const set = styleSet(ps);
  assert.deepEqual(set.to.frameFX, STROKE);
  assert.deepEqual(set.to.scale, pct(486.1111111111111));
  assert.deepEqual(set.to.dropShadow.opacity, pct(60));
  assert.deepEqual(set.to.dropShadow.blur, pxu(4));
  assert.deepEqual(set.to.dropShadow.distance, pxu(6), "unchanged value kept");
  assert.deepEqual(set.to.dropShadow.noise, pct(7), "current extras kept");
});

test("set_layer_style keeps Use Global Light when no angle is given; an angle turns it off", async () => {
  const globalShadow = { ...CURRENT_SHADOW, useGlobalAngle: true, localLightingAngle: { _unit: "angleUnit", _value: 30 } };
  let ps = makeStub({ gets: effectsGet({ 3: { _obj: "layerEffects", scale: pct(100), dropShadow: globalShadow } }) });
  await design.set_layer_style(ps, { doc: 1, layer: 3, style: "drop_shadow", params: { opacity: 50 } });
  let ds = styleSet(ps).to.dropShadow;
  assert.equal(ds.useGlobalAngle, true, "global light kept");
  assert.deepEqual(ds.localLightingAngle, { _unit: "angleUnit", _value: 30 }, "local angle not rewritten");
  // a global shadow whose get carries no local angle gets none written
  const { localLightingAngle, ...noLocal } = globalShadow;
  ps = makeStub({ gets: effectsGet({ 3: { _obj: "layerEffects", scale: pct(100), dropShadow: noLocal } }) });
  await design.set_layer_style(ps, { doc: 1, layer: 3, style: "drop_shadow", enabled: false });
  ds = styleSet(ps).to.dropShadow;
  assert.equal(ds.useGlobalAngle, true);
  assert.equal("localLightingAngle" in ds, false);
  ps = makeStub({ gets: effectsGet({ 3: { _obj: "layerEffects", scale: pct(100), dropShadow: globalShadow } }) });
  await design.set_layer_style(ps, { doc: 1, layer: 3, style: "drop_shadow", params: { angle: 45 } });
  ds = styleSet(ps).to.dropShadow;
  assert.equal(ds.useGlobalAngle, false);
  assert.deepEqual(ds.localLightingAngle, { _unit: "angleUnit", _value: 45 });
});

test("add_layer_style turns Use Global Light off even over a global shadow", async () => {
  const globalShadow = { ...CURRENT_SHADOW, useGlobalAngle: true };
  const ps = makeStub({ gets: effectsGet({ 3: { _obj: "layerEffects", scale: pct(100), dropShadow: globalShadow } }) });
  await design.add_layer_style(ps, { doc: 1, layer: 3, style: "drop_shadow" });
  const ds = styleSet(ps).to.dropShadow;
  assert.equal(ds.useGlobalAngle, false);
  assert.equal(ds.localLightingAngle._value, 120);
});

test("set_layer_style enabled false turns the shadow off without changing values", async () => {
  const ps = makeStub({ gets: effectsGet({ 3: { _obj: "layerEffects", scale: pct(100), dropShadow: CURRENT_SHADOW } }) });
  const r = await design.set_layer_style(ps, { doc: 1, layer: 3, style: "drop_shadow", enabled: false });
  assert.equal(r.enabled, false);
  assert.equal(historyName(ps), "Claude: set_layer_style, drop_shadow off");
  const ds = styleSet(ps).to.dropShadow;
  assert.equal(ds.enabled, false);
  assert.deepEqual(ds.opacity, pct(35));
});

test("set_layer_style: NO_STYLE without a shadow, NOTHING_TO_CHANGE without params, no modal call", async () => {
  const ps = makeStub({ gets: effectsGet({ 3: { _obj: "layerEffects", scale: pct(100), frameFX: STROKE } }) });
  await assert.rejects(design.set_layer_style(ps, { doc: 1, layer: 3, style: "drop_shadow", params: { opacity: 5 } }), { code: "NO_STYLE" });
  await assert.rejects(design.set_layer_style(ps, { doc: 1, layer: 3, style: "drop_shadow", params: {} }), { code: "NOTHING_TO_CHANGE" });
  await assert.rejects(design.set_layer_style(ps, { doc: 1, layer: 3, style: "drop_shadow", params: { blur: 1 } }), { code: "INVALID_ARGS" });
  assert.equal(modalCount(ps), 0);
});

// ---------- clear_layer_style ----------

test("clear_layer_style plays the recorded disableLayerStyle on the selected layer, one step", async () => {
  const ps = makeStub({ gets: effectsGet({ 3: { _obj: "layerEffects", scale: pct(100), frameFX: STROKE, dropShadow: CURRENT_SHADOW } }) });
  const r = await design.clear_layer_style(ps, { doc: 1, layer: 3 });
  assert.deepEqual(r, { ok: true, layer_id: 3, cleared: true, removed: ["frameFX", "dropShadow"] });
  assert.equal(modalCount(ps), 1);
  assert.equal(historyName(ps), "Claude: clear_layer_style, Title");
  const descs = bpDescs(ps).slice(1).map(strip);
  assert.deepEqual(descs, [
    { _obj: "select", _target: [{ _ref: "layer", _id: 3 }], makeVisible: false },
    { _obj: "disableLayerStyle", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] },
  ]);
});

test("clear_layer_style without effects changes nothing and makes no step", async () => {
  const ps = makeStub({ gets: effectsGet({ 3: { _obj: "layerEffects", scale: pct(100) } }) });
  assert.deepEqual(await design.clear_layer_style(ps, { doc: 1, layer: 3 }), { ok: true, layer_id: 3, cleared: false, removed: [] });
  assert.deepEqual(await design.clear_layer_style(ps, { doc: 1, layer: 4 }), { ok: true, layer_id: 4, cleared: false, removed: [] });
  assert.equal(modalCount(ps), 0);
  await assert.rejects(design.clear_layer_style(ps, { doc: 1, layer: 404 }), { code: "NO_LAYER" });
});

test("clear_layer_style without a recording sets layerEffects with every effect removed", async () => {
  design.setRecorded({ clear_layer_style: null });
  try {
    const ps = makeStub({ gets: effectsGet({ 3: { _obj: "layerEffects", scale: pct(300), frameFX: STROKE } }) });
    await design.clear_layer_style(ps, { doc: 1, layer: 3 });
    assert.deepEqual(styleSet(ps).to, { _obj: "layerEffects", scale: pct(300) });
  } finally {
    design.setRecorded(null);
  }
});
