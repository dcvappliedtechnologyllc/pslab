const test = require("node:test");
const assert = require("node:assert/strict");
const { requireAnchor, selectAnchor, placeAbove, placeBelow, isDirectlyAbove, isDirectlyBelow } = require("../lib/place");

// A stub layer tree whose move() really reorders it, recording each call.
function makeTree() {
  const moves = [];
  const doc = { id: 1, layers: [] };
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
  const mk = (id, name, extra = {}) => {
    const layer = {
      id,
      name,
      isClippingMask: false,
      ...extra,
      move(rel, placement) {
        moves.push({ id, rel: rel.id, placement });
        const from = containerOf(layer);
        from.splice(from.indexOf(layer), 1);
        const to = containerOf(rel);
        const i = to.indexOf(rel);
        to.splice(placement === "placeBefore" ? i : i + 1, 0, layer);
      },
    };
    return layer;
  };
  return { doc, moves, mk };
}

const PLACE = { ElementPlacement: { PLACEBEFORE: "placeBefore", PLACEAFTER: "placeAfter" } };

function setup() {
  const t = makeTree();
  const bg = t.mk(1, "Background", { isBackgroundLayer: true });
  const inner = t.mk(6, "Inner");
  const group = t.mk(5, "Group", { layers: [inner] });
  const locked = t.mk(8, "Locked group", { allLocked: true, layers: [t.mk(9, "Inside locked")] });
  const top = t.mk(3, "Top");
  const mid = t.mk(2, "Mid");
  const fresh = t.mk(10, "New", { isClippingMask: true });
  t.doc.layers.push(fresh, top, group, locked, mid, bg);
  const ps = { constants: PLACE, calls: [], action: { async batchPlay(d) { ps.calls.push(d); return d.map(() => ({})); } } };
  return { ...t, ps, bg, top, mid, group, inner, fresh };
}

test("requireAnchor: a missing id is NO_LAYER; a layer inside a locked group is refused", () => {
  const { doc } = setup();
  assert.equal(requireAnchor(doc, 2).name, "Mid");
  assert.equal(requireAnchor(doc, 1).name, "Background");
  assert.equal(requireAnchor(doc, 6).name, "Inner");
  assert.throws(() => requireAnchor(doc, 404), { code: "NO_LAYER" });
  assert.throws(() => requireAnchor(doc, 9), { code: "PROTECTED_LAYER" });
  assert.throws(() => requireAnchor(doc, "x"), { code: "NO_LAYER" });
});

test("selectAnchor selects the anchor by id through batchPlay", async () => {
  const { ps } = setup();
  await selectAnchor(ps, 2);
  assert.equal(ps.calls.length, 1);
  assert.equal(ps.calls[0][0]._obj, "select");
  assert.deepEqual(ps.calls[0][0]._target, [{ _ref: "layer", _id: 2 }]);
  assert.equal(ps.calls[0][0]._options.dialogOptions, "dontDisplay");
});

test("isDirectlyAbove / isDirectlyBelow are sibling-index checks", () => {
  const { doc, fresh, top, mid, bg, inner } = setup();
  assert.equal(isDirectlyAbove(doc, fresh, top), true);
  assert.equal(isDirectlyAbove(doc, top, fresh), false);
  assert.equal(isDirectlyAbove(doc, mid, bg), true);
  assert.equal(isDirectlyAbove(doc, inner, top), false);
  assert.equal(isDirectlyBelow(doc, bg, mid), true);
  assert.equal(isDirectlyBelow(doc, top, fresh), true);
});

test("placeAbove moves with PLACEBEFORE, releases an unwanted clip, and skips a no-op move", async () => {
  const { doc, ps, moves, fresh, mid, bg } = setup();
  await placeAbove(ps, doc, fresh, 1);
  assert.deepEqual(moves, [{ id: 10, rel: 1, placement: "placeBefore" }]);
  assert.deepEqual(doc.layers.map((l) => l.id), [3, 5, 8, 2, 10, 1]);
  assert.equal(fresh.isClippingMask, false);
  await placeAbove(ps, doc, fresh, 1);
  assert.equal(moves.length, 1, "already directly above: no move");
  // asked to stay clipped: the clip is kept
  mid.isClippingMask = true;
  await placeAbove(ps, doc, mid, 10, { clip: true });
  assert.equal(mid.isClippingMask, true);
  assert.ok(bg);
});

test("placeAbove an anchor inside a group puts the layer inside that group", async () => {
  const { doc, ps, fresh, group } = setup();
  await placeAbove(ps, doc, fresh, 6);
  assert.deepEqual(group.layers.map((l) => l.id), [10, 6]);
});

test("placeBelow moves with PLACEAFTER and never below the Background", async () => {
  const { doc, ps, moves, fresh } = setup();
  await placeBelow(ps, doc, fresh, 2);
  assert.deepEqual(moves, [{ id: 10, rel: 2, placement: "placeAfter" }]);
  assert.deepEqual(doc.layers.map((l) => l.id), [3, 5, 8, 2, 10, 1]);
  await placeBelow(ps, doc, fresh, 2);
  assert.equal(moves.length, 1);
  await assert.rejects(placeBelow(ps, doc, fresh, 1), { code: "PROTECTED_LAYER" });
  await assert.rejects(placeAbove(ps, doc, fresh, 404), { code: "NO_LAYER" });
});
