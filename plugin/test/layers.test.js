const test = require("node:test");
const assert = require("node:assert/strict");
const layers = require("../lib/actions/layers");

// Stub ps with a real layer tree: move() reorders it, translate() shifts
// bounds; batchPlay records descriptors (a select by id makes that layer the
// only active one, addToSelection adds to it); executeAsModal records history.
function makeStub() {
  const calls = [];
  const doc = { id: 1, name: "a.psd", width: 1000, height: 800, layers: [], activeLayers: [] };
  const other = { id: 2, name: "b.psd", width: 500, height: 500, layers: [], activeLayers: [] };
  const containerOf = (layer, list = doc.layers) => {
    if (list.includes(layer)) return list;
    for (const l of list) {
      if (l.layers) {
        const c = containerOf(layer, l.layers);
        if (c) return c;
      }
    }
    return null;
  };
  const byId = (id, list = doc.layers) => {
    for (const l of list) {
      if (l.id === id) return l;
      if (l.layers) {
        const f = byId(id, l.layers);
        if (f) return f;
      }
    }
    return null;
  };
  const mk = (id, name, bounds, extra = {}) => {
    const layer = {
      id,
      name,
      kind: "pixel",
      visible: true,
      isClippingMask: false,
      boundsNoEffects: bounds ? { ...bounds } : { left: 0, top: 0, right: 0, bottom: 0 },
      ...extra,
      async move(rel, placement) {
        calls.push(["move", id, rel.id, placement]);
        const from = containerOf(layer);
        from.splice(from.indexOf(layer), 1);
        const to = containerOf(rel);
        const i = to.indexOf(rel);
        to.splice(placement === "placeBefore" ? i : i + 1, 0, layer);
      },
      async translate(dx, dy) {
        calls.push(["translate", id, dx, dy]);
        const shift = (l) => {
          const b = l.boundsNoEffects;
          if (b && b.right > b.left) l.boundsNoEffects = { left: b.left + dx, top: b.top + dy, right: b.right + dx, bottom: b.bottom + dy };
          for (const k of l.layers || []) shift(k);
        };
        shift(layer);
      },
    };
    return layer;
  };
  let active = other;
  const ps = {
    calls,
    doc,
    other,
    mk,
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
        for (const x of descs) {
          if (x._obj === "select" && x._target[0]._ref === "layer") {
            const l = byId(x._target[0]._id);
            if (x.selectionModifier) doc.activeLayers = [...doc.activeLayers, l];
            else doc.activeLayers = [l];
          }
        }
        return descs.map(() => ({}));
      },
    },
  };
  // Title (text, 300..700 x 100..200), Bar 1, Bar 2, a group with one child, Vignette (adjustment, no bounds), Background.
  const title = mk(3, "Title", { left: 300, top: 100, right: 700, bottom: 200 }, { kind: "text" });
  const bar1 = mk(4, "Bar 1", { left: 370, top: 220, right: 630, bottom: 228 });
  const bar2 = mk(5, "Bar 2", { left: 370, top: 240, right: 630, bottom: 248 });
  const inner = mk(7, "Inner", { left: 10, top: 10, right: 110, bottom: 60 });
  const group = mk(6, "Group", { left: 10, top: 10, right: 110, bottom: 60 }, { kind: "group", layers: [inner] });
  const vignette = mk(8, "Vignette", null, { kind: "curves" });
  const bg = mk(1, "Background", { left: 0, top: 0, right: 1000, bottom: 800 }, { isBackgroundLayer: true });
  doc.layers.push(title, bar1, bar2, group, vignette, bg);
  doc.activeLayers = [title];
  return ps;
}

const bpDescs = (ps) => ps.calls.filter((c) => c[0] === "batchPlay").flatMap((c) => c[1]);
const strip = ({ _options, ...rest }) => rest;
const historyName = (ps) => (ps.calls.find((c) => c[0] === "suspendHistory") || [])[1]?.name;
const modalCount = (ps) => ps.calls.filter((c) => c[0] === "executeAsModal").length;
const order = (list) => list.map((l) => l.id);


// ---------- select_layer ----------

test("select_layer selects the first by id, adds the rest, and leaves doc active", async () => {
  const ps = makeStub();
  const r = await layers.select_layer(ps, { doc: 1, layers: [4, 5, 3] });
  assert.deepEqual(r, { active_layer_ids: [4, 5, 3] });
  assert.deepEqual(bpDescs(ps).map(strip), [
    { _obj: "select", _target: [{ _ref: "layer", _id: 4 }], makeVisible: false },
    { _obj: "select", _target: [{ _ref: "layer", _id: 5 }], selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" }, makeVisible: false },
    { _obj: "select", _target: [{ _ref: "layer", _id: 3 }], selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" }, makeVisible: false },
  ]);
  assert.equal(ps.app.activeDocument, ps.doc);
  assert.equal(ps.calls.some((c) => c[0] === "suspendHistory"), false, "no history state");
});

test("select_layer refuses unknown ids, duplicates and empty lists before any modal call", async () => {
  const ps = makeStub();
  await assert.rejects(layers.select_layer(ps, { doc: 1, layers: [4, 404] }), { code: "NO_LAYER" });
  await assert.rejects(layers.select_layer(ps, { doc: 1, layers: [4, 4] }), { code: "INVALID_ARGS" });
  await assert.rejects(layers.select_layer(ps, { doc: 1, layers: [] }), { code: "INVALID_ARGS" });
  await assert.rejects(layers.select_layer(ps, { doc: 9, layers: [4] }), { code: "NO_DOCUMENT" });
  assert.equal(modalCount(ps), 0);
});

test("select_layer falls back to the DOM when addToSelection fails", async () => {
  const ps = makeStub();
  const play = ps.action.batchPlay;
  ps.action.batchPlay = async (descs) => {
    if (descs.some((x) => x.selectionModifier)) return [{ _obj: "error", message: "nope" }];
    return play(descs);
  };
  const bar2 = ps.byId(5);
  Object.defineProperty(bar2, "selected", {
    set(v) {
      if (v) ps.doc.activeLayers = [...ps.doc.activeLayers, bar2];
    },
  });
  const r = await layers.select_layer(ps, { layers: [4, 5], doc: 1 });
  assert.deepEqual(r, { active_layer_ids: [4, 5] });
});

// ---------- reorder_layer ----------

test("reorder_layer above an anchor moves PLACEBEFORE it in one named step", async () => {
  const ps = makeStub();
  const r = await layers.reorder_layer(ps, { doc: 1, layer: 8, above: 3 });
  assert.deepEqual(order(ps.doc.layers), [8, 3, 4, 5, 6, 1]);
  assert.deepEqual(r, { layer_id: 8, index: 0, moved: true });
  assert.equal(historyName(ps), "Claude: reorder_layer, Vignette above Title");
  assert.deepEqual(ps.calls.filter((c) => c[0] === "move"), [["move", 8, 3, "placeBefore"]]);
  assert.equal(ps.app.activeDocument, ps.other, "active document restored");
});

test("reorder_layer below an anchor moves PLACEAFTER it", async () => {
  const ps = makeStub();
  await layers.reorder_layer(ps, { doc: 1, layer: 3, below: 5 });
  assert.deepEqual(order(ps.doc.layers), [4, 5, 3, 6, 8, 1]);
  assert.equal(historyName(ps), "Claude: reorder_layer, Title below Bar 2");
});

test("reorder_layer to top goes above the document's top layer, even from inside a group", async () => {
  const ps = makeStub();
  await layers.reorder_layer(ps, { doc: 1, layer: 7, to: "top" });
  assert.deepEqual(order(ps.doc.layers), [7, 3, 4, 5, 6, 8, 1]);
  assert.equal(historyName(ps), "Claude: reorder_layer, Inner to top");
});

test("reorder_layer to bottom lands directly above the Background", async () => {
  const ps = makeStub();
  await layers.reorder_layer(ps, { doc: 1, layer: 3, to: "bottom" });
  assert.deepEqual(order(ps.doc.layers), [4, 5, 6, 8, 3, 1]);
  assert.equal(historyName(ps), "Claude: reorder_layer, Title to bottom");
});

test("reorder_layer to bottom without a Background goes after the last layer", async () => {
  const ps = makeStub();
  ps.doc.layers.pop();
  await layers.reorder_layer(ps, { doc: 1, layer: 3, to: "bottom" });
  assert.deepEqual(order(ps.doc.layers), [4, 5, 6, 8, 3]);
  assert.deepEqual(ps.calls.filter((c) => c[0] === "move"), [["move", 3, 8, "placeAfter"]]);
});

test("reorder_layer already in place makes no step", async () => {
  for (const args of [{ layer: 3, above: 4 }, { layer: 4, below: 3 }, { layer: 3, to: "top" }, { layer: 8, to: "bottom" }]) {
    const ps = makeStub();
    const r = await layers.reorder_layer(ps, { doc: 1, ...args });
    assert.equal(r.moved, false, JSON.stringify(args));
    assert.equal(modalCount(ps), 0, JSON.stringify(args));
  }
});

test("reorder_layer refusals happen before any modal call", async () => {
  const cases = [
    [{ layer: 1, to: "top" }, "PROTECTED_LAYER"],
    [{ layer: 3, below: 1 }, "PROTECTED_LAYER"],
    [{ layer: 3, above: 3 }, "INVALID_ARGS"],
    [{ layer: 6, above: 7 }, "INVALID_ARGS"], // its own child
    [{ layer: 3 }, "INVALID_ARGS"],
    [{ layer: 3, above: 4, to: "top" }, "INVALID_ARGS"],
    [{ layer: 3, to: "middle" }, "INVALID_ARGS"],
    [{ layer: 404, to: "top" }, "NO_LAYER"],
    [{ layer: 3, above: 404 }, "NO_LAYER"],
  ];
  for (const [args, code] of cases) {
    const ps = makeStub();
    await assert.rejects(layers.reorder_layer(ps, { doc: 1, ...args }), { code }, JSON.stringify(args));
    assert.equal(modalCount(ps), 0, JSON.stringify(args));
  }
});

// ---------- move_layer ----------

const boundsOf = (ps, id) => ps.byId(id).boundsNoEffects;

test("move_layer translates every listed layer by dx/dy in one step", async () => {
  const ps = makeStub();
  const r = await layers.move_layer(ps, { doc: 1, layers: [3, 4, 5], dy: 100 });
  assert.deepEqual(ps.calls.filter((c) => c[0] === "translate"), [["translate", 3, 0, 100], ["translate", 4, 0, 100], ["translate", 5, 0, 100]]);
  assert.equal(modalCount(ps), 1);
  assert.equal(historyName(ps), "Claude: move_layer, 3 layers 0,100");
  assert.deepEqual(r.moved[0], { id: 3, bounds: { left: 300, top: 200, right: 700, bottom: 300 } });
  assert.deepEqual(r.skipped, []);
  assert.equal(r.dx, 0);
  assert.equal(r.dy, 100);
});

test("move_layer absolute puts the union's top-left at (x, y)", async () => {
  const ps = makeStub();
  const r = await layers.move_layer(ps, { doc: 1, layers: [3, 4], x: 200 });
  assert.equal(r.dx, -100);
  assert.equal(r.dy, 0);
  assert.equal(boundsOf(ps, 3).left, 200);
  assert.equal(boundsOf(ps, 4).left, 270);
  assert.equal(historyName(ps), "Claude: move_layer, 2 layers -100,0");
});

test("move_layer skips layers without bounds and moves a group once with its contents", async () => {
  const ps = makeStub();
  const r = await layers.move_layer(ps, { doc: 1, layers: [8, 6, 7], dx: 5 });
  assert.deepEqual(r.skipped, [{ id: 8, name: "Vignette" }]);
  assert.deepEqual(ps.calls.filter((c) => c[0] === "translate"), [["translate", 6, 5, 0]]);
  assert.equal(boundsOf(ps, 7).left, 15);
  assert.equal(historyName(ps), "Claude: move_layer, 1 layer 5,0");
});

test("move_layer falls back to a transform offset when the DOM translate fails", async () => {
  const ps = makeStub();
  ps.byId(4).translate = async () => {
    throw new Error("no translate");
  };
  await layers.move_layer(ps, { doc: 1, layers: [4], dx: 3, dy: 4 });
  const descs = bpDescs(ps).map(strip);
  assert.deepEqual(descs[0], { _obj: "select", _target: [{ _ref: "layer", _id: 4 }], makeVisible: false });
  assert.equal(descs[1]._obj, "transform");
  assert.deepEqual(descs[1].offset.horizontal, { _unit: "pixelsUnit", _value: 3 });
  assert.deepEqual(descs[1].width, { _unit: "percentUnit", _value: 100 });
});

test("move_layer with nothing to move makes no step", async () => {
  const ps = makeStub();
  const r = await layers.move_layer(ps, { doc: 1, layers: [8], dx: 5 });
  assert.deepEqual(r, { moved: [], dx: 0, dy: 0, skipped: [{ id: 8, name: "Vignette" }] });
  const ps2 = makeStub();
  await layers.move_layer(ps2, { doc: 1, layers: [3], x: 300, y: 100 });
  assert.equal(modalCount(ps) + modalCount(ps2), 0);
});

test("move_layer refusals happen before any modal call", async () => {
  const cases = [
    [{ layers: [3] }, "INVALID_ARGS"],
    [{ layers: [3], dx: 1, x: 5 }, "INVALID_ARGS"],
    [{ layers: [3, 3], dx: 1 }, "INVALID_ARGS"],
    [{ layers: [3, 1], dx: 1 }, "PROTECTED_LAYER"],
    [{ layers: [404], dx: 1 }, "NO_LAYER"],
  ];
  for (const [args, code] of cases) {
    const ps = makeStub();
    await assert.rejects(layers.move_layer(ps, { doc: 1, ...args }), { code }, JSON.stringify(args));
    assert.equal(modalCount(ps), 0);
  }
});

// ---------- transform_layer ----------

test("transform_layer scales and rotates about the centre, then offsets it to (cx, cy)", async () => {
  const ps = makeStub();
  const r = await layers.transform_layer(ps, { doc: 1, layer: 3, scale_pct: 76, cx: 500 });
  const descs = bpDescs(ps).map(strip);
  assert.deepEqual(descs[0], { _obj: "select", _target: [{ _ref: "layer", _id: 3 }], makeVisible: false });
  const t = descs[1];
  assert.equal(t._obj, "transform");
  assert.deepEqual(t.freeTransformCenterState, { _enum: "quadCenterState", _value: "QCSAverage" });
  assert.deepEqual(t.width, { _unit: "percentUnit", _value: 76 });
  assert.deepEqual(t.height, { _unit: "percentUnit", _value: 76 });
  assert.deepEqual(t.angle, { _unit: "angleUnit", _value: 0 });
  assert.deepEqual(t.offset.horizontal, { _unit: "pixelsUnit", _value: 0 }); // already centred at 500
  assert.deepEqual(t.offset.vertical, { _unit: "pixelsUnit", _value: 0 });
  assert.equal(historyName(ps), "Claude: transform_layer, 76% 0° @ 500,150");
  assert.equal(r.layer_id, 3);
  assert.ok(r.bounds);
});

test("transform_layer rotate only, moved centre", async () => {
  const ps = makeStub();
  await layers.transform_layer(ps, { doc: 1, layer: 4, rotate_deg: -90, cx: 100, cy: 400 });
  const t = bpDescs(ps).map(strip)[1];
  assert.deepEqual(t.width, { _unit: "percentUnit", _value: 100 });
  assert.deepEqual(t.angle, { _unit: "angleUnit", _value: -90 });
  assert.deepEqual(t.offset.horizontal, { _unit: "pixelsUnit", _value: -400 });
  assert.deepEqual(t.offset.vertical, { _unit: "pixelsUnit", _value: 176 });
  assert.equal(historyName(ps), "Claude: transform_layer, 100% -90° @ 100,400");
});

test("transform_layer refusals happen before any modal call", async () => {
  const cases = [
    [{ layer: 3 }, "INVALID_ARGS"],
    [{ layer: 3, scale_pct: 0 }, "INVALID_ARGS"],
    [{ layer: 3, rotate_deg: 200 }, "INVALID_ARGS"],
    [{ layer: 1, scale_pct: 50 }, "PROTECTED_LAYER"],
    [{ layer: 8, scale_pct: 50 }, "EMPTY_LAYER"],
    [{ layer: 404, scale_pct: 50 }, "NO_LAYER"],
  ];
  for (const [args, code] of cases) {
    const ps = makeStub();
    await assert.rejects(layers.transform_layer(ps, { doc: 1, ...args }), { code }, JSON.stringify(args));
    assert.equal(modalCount(ps), 0);
  }
});

// ---------- align_layers ----------

test("align_layers as_group centres the block on the canvas without changing its shape", async () => {
  const ps = makeStub();
  ps.byId(3).boundsNoEffects = { left: 250, top: 100, right: 650, bottom: 200 };
  const r = await layers.align_layers(ps, { doc: 1, layers: [3, 4, 5], horizontal: "center", as_group: true });
  // union 250..650: centre 450 -> 500
  assert.deepEqual(ps.calls.filter((c) => c[0] === "translate"), [["translate", 3, 50, 0], ["translate", 4, 50, 0], ["translate", 5, 50, 0]]);
  assert.equal(historyName(ps), "Claude: align_layers, 3 layers h-center to canvas as group");
  assert.equal(r.moved.length, 3);
  assert.deepEqual(r.skipped, []);
});

test("align_layers individually to a layer's left and top", async () => {
  const ps = makeStub();
  await layers.align_layers(ps, { doc: 1, layers: [4, 5], to: "layer", to_layer: 3, horizontal: "left", vertical: "top" });
  assert.deepEqual(ps.calls.filter((c) => c[0] === "translate"), [["translate", 4, -70, -120], ["translate", 5, -70, -140]]);
  assert.equal(historyName(ps), "Claude: align_layers, 2 layers h-left v-top to Title");
});

test("align_layers to the selection uses its bounds; no selection is NO_SELECTION", async () => {
  const ps = makeStub();
  ps.doc.selection = { bounds: { left: 0, top: 0, right: 200, bottom: 100 } };
  await layers.align_layers(ps, { doc: 1, layers: [4], to: "selection", vertical: "bottom" });
  assert.deepEqual(ps.calls.filter((c) => c[0] === "translate"), [["translate", 4, 0, -128]]);
  const ps2 = makeStub();
  ps2.doc.selection = { bounds: null };
  await assert.rejects(layers.align_layers(ps2, { doc: 1, layers: [4], to: "selection", vertical: "bottom" }), { code: "NO_SELECTION" });
  assert.equal(modalCount(ps2), 0);
});

test("align_layers already aligned makes no step", async () => {
  const ps = makeStub();
  const r = await layers.align_layers(ps, { doc: 1, layers: [4, 5], horizontal: "center" });
  assert.equal(modalCount(ps), 0);
  assert.equal(r.moved.length, 2);
});

test("align_layers refusals happen before any modal call", async () => {
  const cases = [
    [{ layers: [4] }, "INVALID_ARGS"],
    [{ layers: [4], horizontal: "middle" }, "INVALID_ARGS"],
    [{ layers: [4], horizontal: "left", to: "layer" }, "INVALID_ARGS"],
    [{ layers: [4], horizontal: "left", to_layer: 3 }, "INVALID_ARGS"],
    [{ layers: [4], horizontal: "left", to: "page" }, "INVALID_ARGS"],
    [{ layers: [4], horizontal: "left", to: "layer", to_layer: 8 }, "EMPTY_LAYER"],
    [{ layers: [4], horizontal: "left", to: "layer", to_layer: 404 }, "NO_LAYER"],
    [{ layers: [1], horizontal: "left" }, "PROTECTED_LAYER"],
  ];
  for (const [args, code] of cases) {
    const ps = makeStub();
    await assert.rejects(layers.align_layers(ps, { doc: 1, ...args }), { code }, JSON.stringify(args));
    assert.equal(modalCount(ps), 0);
  }
});
