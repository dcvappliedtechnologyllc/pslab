const test = require("node:test");
const assert = require("node:assert/strict");
const { previewRequest, safeTargetWidth, reconcileBounds } = require("../lib/preview");

const box = (left, top, right, bottom) => ({ left, top, right, bottom });

test("previewRequest avoids an exact integer downscale ratio", () => {
  assert.deepEqual(previewRequest(box(200, 450, 2250, 1150), 1025).targetSize, { width: 1024 });
  assert.deepEqual(previewRequest(box(200, 450, 2251, 1150), 1025).targetSize, { width: 1025 });
  assert.deepEqual(previewRequest(box(400, 800, 2400, 1800), 1000).targetSize, { width: 999 });
  assert.deepEqual(previewRequest(box(400, 800, 2400, 1800), 999).targetSize, { width: 999 });
  assert.deepEqual(previewRequest(box(0, 0, 3000, 50), 1500).targetSize, { width: 1499 });
});

test("previewRequest: no downscale when the long edge fits; tall regions use height", () => {
  const r = previewRequest(box(0, 0, 1000, 600), 1500);
  assert.equal(r.targetSize, null);
  assert.deepEqual(r.sourceBounds, box(0, 0, 1000, 600));
  assert.equal(previewRequest(box(0, 0, 1500, 600), 1500).targetSize, null);
  assert.deepEqual(previewRequest(box(0, 0, 1000, 3000), 1500).targetSize, { height: 1499 });
  assert.deepEqual(previewRequest(box(0, 0, 1000, 3001), 1500).targetSize, { height: 1500 });
});

test("previewRequest steps down again if the next size is also an exact divisor", () => {
  // 39800 = 200 x 199: both 200 and 199 divide it exactly, 198 does not
  assert.deepEqual(previewRequest(box(0, 0, 39800, 10), 200).targetSize, { width: 198 });
});

test("safeTargetWidth uses the same rule", () => {
  assert.equal(safeTargetWidth(1024, 512), 511);
  assert.equal(safeTargetWidth(1000, 512), 512);
  assert.equal(safeTargetWidth(512, 512), null);
  assert.equal(safeTargetWidth(300, 512), null);
  assert.equal(safeTargetWidth(768, 256), 255);
});

test("reconcileBounds: missing or matching returned bounds keep the request", () => {
  const req = box(200, 450, 2250, 1150);
  assert.deepEqual(reconcileBounds(req, undefined), { region: req, mismatch: false });
  assert.deepEqual(reconcileBounds(req, box(201, 450, 2250, 1149)), { region: req, mismatch: false });
});

test("reconcileBounds: bounds in pyramid-level coordinates are not a mismatch", () => {
  const req = box(200, 450, 2250, 1150);
  assert.deepEqual(reconcileBounds(req, box(100, 225, 1125, 575), 1), { region: req, mismatch: false });
});

test("reconcileBounds: other returned bounds win and are flagged", () => {
  const req = box(200, 450, 2250, 1150);
  const got = box(94, 277, 2144, 977);
  assert.deepEqual(reconcileBounds(req, got, 0), { region: got, mismatch: true });
  assert.deepEqual(reconcileBounds(req, { left: { _value: 94 }, top: 277, right: 2144, bottom: 977 }), { region: got, mismatch: true });
});
