const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../lib/layout");

const box = (left, top, right, bottom) => ({ left, top, right, bottom });

test("unionBounds covers every box and skips nulls", () => {
  assert.deepEqual(L.unionBounds([box(10, 20, 30, 40), null, box(5, 25, 20, 50)]), box(5, 20, 30, 50));
  assert.equal(L.unionBounds([]), null);
  assert.equal(L.unionBounds([null]), null);
});

test("moveDelta relative: dx/dy as given, a missing axis is 0, rounded to whole pixels", () => {
  const u = box(100, 200, 300, 400);
  assert.deepEqual(L.moveDelta(u, { dx: 10, dy: -5 }), { dx: 10, dy: -5 });
  assert.deepEqual(L.moveDelta(u, { dy: 100 }), { dx: 0, dy: 100 });
  assert.deepEqual(L.moveDelta(u, { dx: 2.6 }), { dx: 3, dy: 0 });
});

test("moveDelta absolute moves the union's top-left to (x, y); a missing axis stays", () => {
  const u = box(100, 200, 300, 400);
  assert.deepEqual(L.moveDelta(u, { x: 200, y: 50 }), { dx: 100, dy: -150 });
  assert.deepEqual(L.moveDelta(u, { x: 200 }), { dx: 100, dy: 0 });
  assert.deepEqual(L.moveDelta(u, { y: 200 }), { dx: 0, dy: 0 });
});

test("transformDelta moves the bounds centre to (cx, cy); a missing axis keeps it", () => {
  const b = box(100, 200, 300, 400); // centre 200, 300
  assert.deepEqual(L.transformDelta(b, {}), { dx: 0, dy: 0, cx: 200, cy: 300 });
  assert.deepEqual(L.transformDelta(b, { cx: 500 }), { dx: 300, dy: 0, cx: 500, cy: 300 });
  assert.deepEqual(L.transformDelta(b, { cx: 150, cy: 250 }), { dx: -50, dy: -50, cx: 150, cy: 250 });
  assert.deepEqual(L.transformDelta(box(0, 0, 5, 5), { cx: 3 }), { dx: 0.5, dy: 0, cx: 3, cy: 2.5 });
});

test("alignDeltas: each of the six edges, per layer", () => {
  const t = box(0, 0, 1000, 800);
  const boxes = [box(100, 100, 300, 200), box(400, 500, 500, 520)];
  const run = (opts) => L.alignDeltas(boxes, t, opts, false);
  assert.deepEqual(run({ horizontal: "left" }), [{ dx: -100, dy: 0 }, { dx: -400, dy: 0 }]);
  assert.deepEqual(run({ horizontal: "right" }), [{ dx: 700, dy: 0 }, { dx: 500, dy: 0 }]);
  assert.deepEqual(run({ horizontal: "center" }), [{ dx: 300, dy: 0 }, { dx: 50, dy: 0 }]);
  assert.deepEqual(run({ vertical: "top" }), [{ dx: 0, dy: -100 }, { dx: 0, dy: -500 }]);
  assert.deepEqual(run({ vertical: "bottom" }), [{ dx: 0, dy: 600 }, { dx: 0, dy: 280 }]);
  assert.deepEqual(run({ vertical: "center", horizontal: "left" }), [{ dx: -100, dy: 250 }, { dx: -400, dy: -110 }]);
});

test("alignDeltas as a group: one delta for the union, so the block keeps its shape", () => {
  const t = box(0, 0, 1000, 800);
  const boxes = [box(300, 100, 700, 200), box(370, 220, 630, 228)];
  // union 300..700 x 100..228: centre x 500 is already the canvas centre
  assert.deepEqual(L.alignDeltas(boxes, t, { horizontal: "center" }, true), [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  assert.deepEqual(L.alignDeltas(boxes, t, { vertical: "bottom" }, true), [{ dx: 0, dy: 572 }, { dx: 0, dy: 572 }]);
  assert.deepEqual(L.alignDeltas([], t, { vertical: "bottom" }, true), []);
});

test("alignDeltas to a target layer's box, rounded to whole pixels", () => {
  const target = box(10, 10, 111, 60); // centre x 60.5
  assert.deepEqual(L.alignDeltas([box(0, 0, 20, 20)], target, { horizontal: "center" }, false), [{ dx: 51, dy: 0 }]);
});

// ---------- B3: sample planning ----------

// Title (text), Light group [Light A, Light B], Bars group [Bar (clipped), Base], Patch (hidden), Background.
const tree = () => [
  { id: 3, kind: "text", visible: true },
  { id: 10, kind: "group", visible: true, layers: [{ id: 11, kind: "curves", visible: true }, { id: 12, kind: "exposure", visible: true }] },
  { id: 20, kind: "group", visible: true, layers: [{ id: 21, kind: "pixel", visible: true, isClippingMask: true }, { id: 22, kind: "pixel", visible: true }] },
  { id: 30, kind: "pixel", visible: false },
  { id: 1, kind: "pixel", visible: true, isBackgroundLayer: true },
];

test("belowIds: the anchor and everything painted under it", () => {
  assert.deepEqual(L.belowIds(tree(), 1), [1]);
  assert.deepEqual(L.belowIds(tree(), 20), [20, 21, 22, 30, 1]);
  assert.deepEqual(L.belowIds(tree(), 22), [22, 30, 1]);
  assert.deepEqual(L.belowIds(tree(), 404), []);
});

test("hidePlan hides visible layers that are not kept, keeping kept layers' groups", () => {
  assert.deepEqual(L.hidePlan(tree(), [1]), [3, 10, 20]); // 30 is already hidden
  assert.deepEqual(L.hidePlan(tree(), L.belowIds(tree(), 22)), [3, 10, 21]); // group 20 stays visible for 22
  assert.deepEqual(L.hidePlan(tree(), [11, 1]), [3, 12, 20]);
  assert.deepEqual(L.hidePlan(tree(), [10, 1]), [3, 20]); // a kept group keeps its contents
});

test("hidePlan keeps the base of a kept clipped layer", () => {
  assert.deepEqual(L.hidePlan(tree(), [21]), [3, 10, 1]);
});

test("visibleLeaves lists what still shows after hiding", () => {
  const ids = (list) => list.map((l) => l.id);
  assert.deepEqual(ids(L.visibleLeaves(tree(), [])), [3, 11, 12, 21, 22, 1]);
  assert.deepEqual(ids(L.visibleLeaves(tree(), [3, 10, 20])), [1]);
  assert.deepEqual(ids(L.visibleLeaves(tree(), [3, 10, 20, 1])), []);
});
