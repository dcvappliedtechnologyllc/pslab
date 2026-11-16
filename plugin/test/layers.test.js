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
