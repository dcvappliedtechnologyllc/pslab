const test = require("node:test");
const assert = require("node:assert/strict");
const geometry = require("../lib/actions/geometry");
const D = require("../lib/descriptors");

const RAD = Math.PI / 180;

// RGB image of a bright vertical line tilted tiltDeg clockwise (top leans right).
function tiltedLineRgb(w, h, tiltDeg) {
  const data = new Uint8Array(w * h * 3);
  const t = tiltDeg * RAD;
  const dir = [Math.sin(t), -Math.cos(t)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = Math.abs((x - w / 2) * dir[1] - (y - h / 2) * dir[0]);
      const v = Math.round(255 * Math.min(1, Math.max(0, 2 - dist)));
      data.set([v, v, v], (y * w + x) * 3);
    }
  }
  return data;
}

// Stub ps: document 1 (600x400, Background id 1 plus "Lamp" id 2 on top) and
// document 3 active at the start, so restoring the active document is observable.
function makeStub({
  failOn = null,
  noBackground = false,
  pixels = null,
  pixelSize = [300, 300],
  onlyBase = false,
  stampClipped = false,
} = {}) {
  const calls = [];
  let nextId = 100;

  function makeLayer(doc, id, name, bounds, extra = {}) {
    return {
      id,
      _name: name,
      bounds: { ...bounds },
      ...extra,
      get name() {
        return this._name;
      },
      set name(v) {
        calls.push(["rename", this.id, v]);
        this._name = v;
      },
      async duplicate() {
        calls.push(["duplicate", this.id]);
        const l = makeLayer(doc, nextId++, `${this._name} copy`, this.bounds);
        const i = doc.layers.indexOf(this);
        doc.layers.splice(i, 0, l); // directly above
        doc.activeLayers = [l];
        return l;
      },
    };
  }

  const doc = { id: 1, name: "room.jpg", width: 600, height: 400, layers: [], activeLayers: [], selection: {} };
  const full = { left: 0, top: 0, right: 600, bottom: 400 };
  const bg = makeLayer(doc, 1, noBackground ? "Layer 0" : "Background", full, { isBackgroundLayer: !noBackground });
  const lamp = makeLayer(doc, 2, "Lamp", { left: 50, top: 50, right: 150, bottom: 150 }, { isBackgroundLayer: false });
  doc.layers = onlyBase ? [bg] : [lamp, bg];
  doc.activeLayers = [doc.layers[0]];
  const other = { id: 3, name: "other.psd", width: 10, height: 10, layers: [], activeLayers: [] };

  let active = other;
  let sel = null;
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
    imaging: {
      async getPixels(opts) {
        calls.push(["getPixels", opts]);
        const [w, h] = pixelSize;
        const data = pixels ? pixels(w, h) : new Uint8Array(w * h * 3).fill(128);
        return {
          imageData: {
            width: w,
            height: h,
            components: 3,
            async getData(o) {
              calls.push(["getData", o]);
              return data;
            },
            dispose() {
              calls.push(["dispose"]);
            },
          },
        };
      },
    },
    core: {
      async executeAsModal(fn, options) {
        calls.push(["executeAsModal", options.commandName]);
        return fn({
          hostControl: {
            async suspendHistory(o) {
              calls.push(["suspendHistory", o]);
              return 77;
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
          if (failOn && desc._obj === failOn) return { _obj: "error", message: `${failOn} failed` };
          const top = active.activeLayers[0];
          if (desc._obj === "select" && desc._target[0]._ref === "layer") {
            const l = active.layers.find((x) => x.id === desc._target[0]._id);
            if (l) active.activeLayers = [l];
          }
          if (desc._obj === "newPlacedLayer") top.id = nextId++; // the smart object gets a new id
          if (desc._obj === "mergeVisible") {
            const l = makeLayer(active, nextId++, "Layer 1", full);
            if (stampClipped) {
              // stamped above a clipped layer: Photoshop puts it in the clipping group
              l._clip = true;
              Object.defineProperty(l, "isClippingMask", {
                get() {
                  return this._clip;
                },
                set(v) {
                  calls.push(["isClippingMask", this.id, v]);
                  this._clip = v;
                },
              });
            }
            active.layers.splice(active.layers.indexOf(top), 0, l);
            active.activeLayers = [l];
          }
          // Track the selection's box so Clear can shrink the layer to the kept patch.
          if (desc._obj === "set" && desc._target[0]._property === "selection") {
            const to = desc.to;
            if (to._obj === "rectangle") {
              sel = { left: to.left._value, top: to.top._value, right: to.right._value, bottom: to.bottom._value };
            } else if (to._obj === "polygon") {
              const xs = to.points.map((p) => p.horizontal._value);
              const ys = to.points.map((p) => p.vertical._value);
              sel = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
            } else sel = null;
          }
          if (desc._obj === "expand" && sel) {
            const e = desc.by._value;
            sel = { left: sel.left - e, top: sel.top - e, right: sel.right + e, bottom: sel.bottom + e };
          }
          if (desc._obj === "delete" && !desc._target && sel) top.bounds = { ...sel };
          if (desc._obj === "transform") {
            const b = top.bounds;
            const dx = desc.offset.horizontal._value;
            const dy = desc.offset.vertical._value;
            top.bounds = { left: b.left + dx, top: b.top + dy, right: b.right + dx, bottom: b.bottom + dy };
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
const resumes = (ps) => ps.calls.filter((c) => c[0] === "resumeHistory").map((c) => c[2]);
const modalCount = (ps) => ps.calls.filter((c) => c[0] === "executeAsModal").length;

// ---------- straighten ----------

test("straighten angle_deg: duplicates the Background, smart object, rotates, one named step", async () => {
  const ps = makeStub();
  const res = await geometry.straighten(ps, { doc: 1, angle_deg: -1.5 });
  assert.deepEqual(suspends(ps), [{ documentID: 1, name: "Claude: straighten, -1.5°" }]);
  assert.deepEqual(resumes(ps), [true]);
  assert.deepEqual(ps.calls.find((c) => c[0] === "duplicate"), ["duplicate", 1]);
  assert.deepEqual(ps.calls.find((c) => c[0] === "rename"), ["rename", 100, "Straightened"]);
  assert.deepEqual(allDescs(ps), [
    D.selectLayerById(100),
    D.newPlacedLayer(),
    D.transform({ scalePct: 100, angleDeg: -1.5 }),
  ]);
  assert.deepEqual(res, { layer_id: 101, angle_deg: -1.5, method: "free_transform" });
  // the Straightened copy sits directly above the untouched Background
  assert.deepEqual(ps.doc.layers.map((l) => l.name), ["Lamp", "Straightened", "Background"]);
  assert.equal(ps.app.activeDocument, ps.other);
  assert.ok(!ps.calls.some((c) => c[0] === "getPixels"));
});

test("straighten without a Background duplicates the bottom layer", async () => {
  const ps = makeStub({ noBackground: true });
  await geometry.straighten(ps, { doc: 1, angle_deg: 2 });
  assert.deepEqual(ps.calls.find((c) => c[0] === "duplicate"), ["duplicate", 1]);
});

test("straighten refuses ALREADY_STRAIGHTENED before any modal when a Straightened layer exists", async () => {
  for (const args of [{ doc: 1, angle_deg: 2 }, { doc: 1, auto: true }]) {
    const ps = makeStub();
    ps.doc.layers[0]._name = "Straightened";
    await assert.rejects(
      geometry.straighten(ps, args),
      (e) => e.code === "ALREADY_STRAIGHTENED" && /delete_layer/.test(e.message) && /hide/.test(e.message),
    );
    assert.equal(modalCount(ps), 0);
  }
  // found inside a group too
  const ps = makeStub();
  ps.doc.layers[0].layers = [{ id: 50, name: "Straightened" }];
  await assert.rejects(geometry.straighten(ps, { doc: 1, angle_deg: 2 }), (e) => e.code === "ALREADY_STRAIGHTENED");
  assert.equal(modalCount(ps), 0);
});

test("straighten runs again once the old Straightened layer is hidden", async () => {
  const ps = makeStub();
  ps.doc.layers[0]._name = "Straightened";
  ps.doc.layers[0].visible = false;
  const res = await geometry.straighten(ps, { doc: 1, angle_deg: 2 });
  assert.equal(res.angle_deg, 2);
  assert.deepEqual(resumes(ps), [true]);
});

test("straighten rejects bad args before any modal", async () => {
  for (const args of [
    { doc: 1 },
    { doc: 1, angle_deg: 2, auto: true },
    { doc: 1, angle_deg: 46 },
    { doc: 1, angle_deg: -45.1 },
    { doc: 1, angle_deg: "2" },
    { doc: 1, auto: false },
  ]) {
    const ps = makeStub();
    await assert.rejects(geometry.straighten(ps, args), (e) => e.code === "INVALID_ARGS", JSON.stringify(args));
    assert.equal(modalCount(ps), 0);
  }
});

test("straighten auto measures a downscaled composite and applies the rounded estimate", async () => {
  const ps = makeStub({ pixels: (w, h) => tiltedLineRgb(w, h, 2) });
  const res = await geometry.straighten(ps, { doc: 1, auto: true });
  const gp = ps.calls.find((c) => c[0] === "getPixels")[1];
  assert.deepEqual(gp, {
    documentID: 1,
    sourceBounds: { left: 0, top: 0, right: 600, bottom: 400 },
    targetSize: { width: 600 },
    componentSize: 8,
    applyAlpha: true,
    colorSpace: "RGB",
  });
  assert.ok(ps.calls.some((c) => c[0] === "dispose"));
  // applied = measured rounded to 0.1
  assert.ok(Math.abs(res.angle_deg + 2) <= 0.15, `applied ${res.angle_deg}`);
  assert.equal(res.angle_deg, Math.round(res.measured.angle_deg * 10) / 10);
  assert.equal(res.method, "free_transform");
  assert.ok(Math.abs(res.measured.angle_deg + 2) <= 0.15);
  assert.ok(res.measured.confidence >= 0.05);
  assert.ok(res.measured.edges_used >= 50);
  assert.equal(res.measured.preview_width, 300);
  // the measurement is a read (no history), then exactly one named step
  assert.deepEqual(suspends(ps), [{ documentID: 1, name: `Claude: straighten, ${res.angle_deg}°` }]);
  assert.deepEqual(allDescs(ps).at(-1), D.transform({ scalePct: 100, angleDeg: res.angle_deg }));
});

test("straighten auto on a portrait document downscales by height to 768", async () => {
  const ps = makeStub({ pixels: (w, h) => tiltedLineRgb(w, h, 2) });
  ps.doc.width = 3000;
  ps.doc.height = 4000;
  await geometry.straighten(ps, { doc: 1, auto: true });
  assert.deepEqual(ps.calls.find((c) => c[0] === "getPixels")[1].targetSize, { height: 768 });
});

test("straighten auto on a flat image throws NO_EDGES before any history step", async () => {
  const ps = makeStub();
  await assert.rejects(geometry.straighten(ps, { doc: 1, auto: true }), (e) => e.code === "NO_EDGES");
  assert.deepEqual(suspends(ps), []);
  assert.ok(!ps.calls.some((c) => c[0] === "batchPlay"));
  assert.ok(ps.calls.some((c) => c[0] === "dispose"));
});

test("straighten: a failing batchPlay rolls back and surfaces the code", async () => {
  const ps = makeStub({ failOn: "transform" });
  await assert.rejects(geometry.straighten(ps, { doc: 1, angle_deg: 3 }), (e) => e.code === "BATCHPLAY");
  assert.deepEqual(resumes(ps), [false]);
  assert.equal(ps.app.activeDocument, ps.other);
});

// ---------- content_aware_fill ----------

const cafTail = [D.contentAwareFill(), D.inverseSelection(), D.clearSelected(), D.deselect()];

test("content_aware_fill bbox: stamp on top, select, expand 2, fill, keep only the patch", async () => {
  const ps = makeStub();
  const bbox = { left: 100, top: 120, right: 180, bottom: 200 };
  const res = await geometry.content_aware_fill(ps, { doc: 1, bbox, name: "Outlet removed" });
  assert.deepEqual(suspends(ps), [{ documentID: 1, name: "Claude: content_aware_fill, Outlet removed" }]);
  assert.deepEqual(resumes(ps), [true]);
  assert.deepEqual(allDescs(ps), [
    D.selectLayerById(2), // the top layer, so the stamp lands on top
    D.stampVisible(),
    D.selectRectangle(bbox),
    D.expand(2),
    ...cafTail,
  ]);
  assert.deepEqual(ps.calls.find((c) => c[0] === "rename"), ["rename", 100, "Outlet removed"]);
  assert.deepEqual(res, { layer_id: 100, bounds: { left: 98, top: 118, right: 182, bottom: 202 } });
  assert.deepEqual(ps.doc.layers.map((l) => l.name), ["Outlet removed", "Lamp", "Background"]);
  assert.equal(ps.app.activeDocument, ps.other);
});

test("content_aware_fill on a Background-only document duplicates it instead of Stamp Visible", async () => {
  const ps = makeStub({ onlyBase: true });
  const bbox = { left: 100, top: 120, right: 180, bottom: 200 };
  const res = await geometry.content_aware_fill(ps, { doc: 1, bbox, name: "Patch" });
  assert.deepEqual(ps.calls.find((c) => c[0] === "duplicate"), ["duplicate", 1]);
  assert.deepEqual(allDescs(ps), [D.selectLayerById(100), D.selectRectangle(bbox), D.expand(2), ...cafTail]);
  assert.ok(!allDescs(ps).some((d) => d._obj === "mergeVisible"));
  assert.equal(res.layer_id, 100);
  assert.deepEqual(ps.doc.layers.map((l) => l.name), ["Patch", "Background"]);
  assert.deepEqual(resumes(ps), [true]);
});

test("content_aware_fill releases a stamp that joined a clipping group", async () => {
  const ps = makeStub({ stampClipped: true });
  await geometry.content_aware_fill(ps, { doc: 1, bbox: { left: 1, top: 1, right: 9, bottom: 9 }, name: "P" });
  assert.deepEqual(ps.calls.find((c) => c[0] === "isClippingMask"), ["isClippingMask", 100, false]);
  assert.equal(ps.doc.layers[0].isClippingMask, false);
});

test("content_aware_fill leaves an unclipped stamp alone", async () => {
  const ps = makeStub();
  await geometry.content_aware_fill(ps, { doc: 1, bbox: { left: 1, top: 1, right: 9, bottom: 9 }, name: "P" });
  assert.ok(!ps.calls.some((c) => c[0] === "isClippingMask"));
});

test("content_aware_fill polygon selects the polygon", async () => {
  const ps = makeStub();
  const polygon = [{ x: 10, y: 10 }, { x: 60, y: 12 }, { x: 30, y: 50 }];
  const res = await geometry.content_aware_fill(ps, { doc: 1, polygon, name: "Patch" });
  assert.deepEqual(allDescs(ps), [D.selectLayerById(2), D.stampVisible(), D.selectPolygon(polygon), D.expand(2), ...cafTail]);
  assert.deepEqual(res.bounds, { left: 8, top: 8, right: 62, bottom: 52 });
});

test("content_aware_fill rejects bad args before any modal", async () => {
  const bbox = { left: 10, top: 10, right: 50, bottom: 50 };
  const tri = [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 3, y: 4 }];
  for (const args of [
    { doc: 1, name: "x" },
    { doc: 1, bbox, polygon: tri, name: "x" },
    { doc: 1, bbox },
    { doc: 1, bbox, name: "" },
    { doc: 1, bbox: { left: 50, top: 10, right: 10, bottom: 50 }, name: "x" },
    { doc: 1, bbox: { left: 0, top: 0, right: 601, bottom: 50 }, name: "x" },
    { doc: 1, bbox: { left: -1, top: 0, right: 10, bottom: 50 }, name: "x" },
    { doc: 1, polygon: tri.slice(0, 2), name: "x" },
    { doc: 1, polygon: [...tri.slice(0, 2), { x: 700, y: 3 }], name: "x" },
  ]) {
    const ps = makeStub();
    await assert.rejects(geometry.content_aware_fill(ps, args), (e) => e.code === "INVALID_ARGS", JSON.stringify(args));
    assert.equal(modalCount(ps), 0);
  }
});

test("content_aware_fill: a failing fill rolls back and surfaces the code", async () => {
  const ps = makeStub({ failOn: "fill" });
  await assert.rejects(
    geometry.content_aware_fill(ps, { doc: 1, bbox: { left: 1, top: 1, right: 9, bottom: 9 }, name: "P" }),
    (e) => e.code === "BATCHPLAY" && /fill/.test(e.message),
  );
  assert.deepEqual(resumes(ps), [false]);
  assert.equal(ps.app.activeDocument, ps.other);
});

// ---------- clone_from ----------

const src_bbox = { left: 100, top: 50, right: 200, bottom: 130 };
const keepSrc = [D.selectRectangle(src_bbox), D.inverseSelection(), D.clearSelected(), D.deselect()];

test("clone_from: stamp, keep src_bbox, move its top-left to dst, no mask by default", async () => {
  const ps = makeStub();
  const res = await geometry.clone_from(ps, { doc: 1, src_bbox, dst: { x: 300, y: 250 }, name: "Floor patch" });
  assert.deepEqual(suspends(ps), [{ documentID: 1, name: "Claude: clone_from, Floor patch" }]);
  assert.deepEqual(resumes(ps), [true]);
  assert.deepEqual(allDescs(ps), [
    D.selectLayerById(2),
    D.stampVisible(),
    ...keepSrc,
    D.selectLayerById(100),
    D.transform({ scalePct: 100, dx: 200, dy: 200 }),
  ]);
  assert.deepEqual(ps.calls.find((c) => c[0] === "rename"), ["rename", 100, "Floor patch"]);
  assert.deepEqual(res, { layer_id: 100, bounds: { left: 300, top: 250, right: 400, bottom: 330 }, feather_px: 0 });
  assert.equal(ps.app.activeDocument, ps.other);
});

test("clone_from with feather_px masks the moved box contracted then feathered", async () => {
  const ps = makeStub();
  const res = await geometry.clone_from(ps, { doc: 1, src_bbox, dst: { x: 20, y: 10 }, name: "Soft", feather_px: 12 });
  const moved = { left: 20, top: 10, right: 120, bottom: 90 };
  assert.deepEqual(allDescs(ps), [
    D.selectLayerById(2),
    D.stampVisible(),
    ...keepSrc,
    D.selectLayerById(100),
    D.transform({ scalePct: 100, dx: -80, dy: -40 }),
    D.selectRectangle(moved),
    D.contract(12),
    D.feather(12),
    D.makeMaskFromSelection("reveal"),
    D.deselect(),
  ]);
  assert.equal(res.feather_px, 12);
});

test("clone_from on a single-layer document duplicates it instead of Stamp Visible", async () => {
  const ps = makeStub({ onlyBase: true, noBackground: true });
  const res = await geometry.clone_from(ps, { doc: 1, src_bbox, dst: { x: 300, y: 250 }, name: "Floor patch" });
  assert.deepEqual(allDescs(ps), [
    D.selectLayerById(100),
    ...keepSrc,
    D.selectLayerById(100),
    D.transform({ scalePct: 100, dx: 200, dy: 200 }),
  ]);
  assert.equal(res.layer_id, 100);
});

test("clone_from releases a clipped stamp", async () => {
  const ps = makeStub({ stampClipped: true });
  await geometry.clone_from(ps, { doc: 1, src_bbox, dst: { x: 0, y: 0 }, name: "P" });
  assert.deepEqual(ps.calls.find((c) => c[0] === "isClippingMask"), ["isClippingMask", 100, false]);
});

test("clone_from rejects bad args before any modal", async () => {
  const dst = { x: 10, y: 10 };
  for (const args of [
    { doc: 1, src_bbox, dst },
    { doc: 1, src_bbox, dst, name: "" },
    { doc: 1, dst, name: "x" },
    { doc: 1, src_bbox: { left: 100, top: 50, right: 700, bottom: 130 }, dst, name: "x" },
    { doc: 1, src_bbox: { left: 200, top: 50, right: 100, bottom: 130 }, dst, name: "x" },
    { doc: 1, src_bbox, name: "x" },
    { doc: 1, src_bbox, dst: { x: 600, y: 10 }, name: "x" },
    { doc: 1, src_bbox, dst: { x: 10, y: -1 }, name: "x" },
    { doc: 1, src_bbox, dst, name: "x", feather_px: -1 },
    { doc: 1, src_bbox, dst, name: "x", feather_px: 201 },
    { doc: 1, src_bbox, dst, name: "x", feather_px: 40 }, // 2 * 40 >= 80 (the box's height)
  ]) {
    const ps = makeStub();
    await assert.rejects(geometry.clone_from(ps, args), (e) => e.code === "INVALID_ARGS", JSON.stringify(args));
    assert.equal(modalCount(ps), 0);
  }
});

test("clone_from: a failing transform rolls back and surfaces the code", async () => {
  const ps = makeStub({ failOn: "transform" });
  await assert.rejects(
    geometry.clone_from(ps, { doc: 1, src_bbox, dst: { x: 0, y: 0 }, name: "P" }),
    (e) => e.code === "BATCHPLAY" && /transform/.test(e.message),
  );
  assert.deepEqual(resumes(ps), [false]);
  assert.equal(ps.app.activeDocument, ps.other);
});
