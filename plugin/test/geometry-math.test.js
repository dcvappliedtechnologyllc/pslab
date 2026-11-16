const test = require("node:test");
const assert = require("node:assert/strict");
const { estimateTilt, toGray, round1 } = require("../lib/geometry");

const RAD = Math.PI / 180;

// A bright, anti-aliased line on black through the image center. tiltDeg is
// clockwise on screen (image y down): for a vertical line the top leans right.
function lineImage(w, h, tiltDeg, { vertical = true, halfWidth = 1.5 } = {}) {
  const gray = new Float32Array(w * h);
  const t = tiltDeg * RAD;
  // unit direction of the line
  const dir = vertical ? [Math.sin(t), -Math.cos(t)] : [Math.cos(t), Math.sin(t)];
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const vx = x - cx;
      const vy = y - cy;
      const dist = Math.abs(vx * dir[1] - vy * dir[0]);
      const v = Math.min(1, Math.max(0, halfWidth + 0.5 - dist));
      gray[y * w + x] = 255 * v;
    }
  }
  return gray;
}

test("a vertical line tilted +2 deg clockwise measures -2 deg to apply", () => {
  const r = estimateTilt(lineImage(300, 300, 2), 300, 300, { vertical: true });
  assert.ok(Math.abs(r.angle_deg - -2) <= 0.15, `got ${r.angle_deg}`);
  assert.ok(r.edges_used >= 50);
  assert.ok(r.confidence > 0.5, `confidence ${r.confidence}`);
});

test("the sign follows the tilt: -3 deg measures +3 deg", () => {
  const r = estimateTilt(lineImage(300, 300, -3), 300, 300);
  assert.ok(Math.abs(r.angle_deg - 3) <= 0.15, `got ${r.angle_deg}`);
});

test("a horizontal line tilted +2 deg clockwise measures -2 deg with vertical:false", () => {
  const img = lineImage(300, 300, 2, { vertical: false });
  const r = estimateTilt(img, 300, 300, { vertical: false });
  assert.ok(Math.abs(r.angle_deg - -2) <= 0.15, `got ${r.angle_deg}`);
  assert.ok(r.edges_used >= 50);
  // the same image has no near-vertical edges
  assert.equal(estimateTilt(img, 300, 300, { vertical: true }).edges_used, 0);
});

test("a straight vertical line measures 0", () => {
  const r = estimateTilt(lineImage(300, 300, 0), 300, 300);
  assert.equal(r.angle_deg, 0);
});

test("a flat image has no edges and zero confidence", () => {
  const r = estimateTilt(new Float32Array(300 * 300).fill(128), 300, 300);
  assert.deepEqual(r, { angle_deg: 0, confidence: 0, edges_used: 0, edges_total: 0 });
});

test("a line tilted beyond 12 deg is ignored", () => {
  const r = estimateTilt(lineImage(300, 300, 20), 300, 300);
  assert.equal(r.edges_used, 0);
  assert.ok(r.edges_total > 0);
});

test("toGray uses the single value for 1 component (gray) and the first of 2 (gray + alpha)", () => {
  assert.deepEqual(Array.from(toGray([0, 77, 255], 3, 1, 1)), [0, 77, 255]);
  assert.deepEqual(Array.from(toGray([40, 255, 200, 0], 2, 1, 2)), [40, 200]);
});

test("toGray weights RGB and ignores alpha with 4 components", () => {
  const g = Array.from(toGray([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128], 3, 1, 4));
  assert.deepEqual(g.map((v) => Math.round(v * 100) / 100), [54.21, 182.38, 18.41]);
});

test("toGray handles 3 and 4 components", () => {
  assert.deepEqual(Array.from(toGray([255, 255, 255, 0, 0, 0], 2, 1, 3)).map(Math.round), [255, 0]);
  assert.deepEqual(Array.from(toGray([255, 255, 255, 9, 0, 0, 0, 9], 2, 1, 4)).map(Math.round), [255, 0]);
});

test("round1 rounds to 0.1 without -0", () => {
  assert.equal(round1(-1.96), -2);
  assert.equal(round1(-0.04), 0);
  assert.ok(!Object.is(round1(-0.04), -0));
  assert.equal(round1(2.04), 2);
});

const { coversCanvas, polygonCoversCanvas } = require("../lib/geometry");

test("coversCanvas: the box reaches every canvas edge (optionally after a margin)", () => {
  assert.equal(coversCanvas({ left: 0, top: 0, right: 600, bottom: 400 }, 600, 400), true);
  assert.equal(coversCanvas({ left: -5, top: -5, right: 700, bottom: 500 }, 600, 400), true);
  assert.equal(coversCanvas({ left: 1, top: 0, right: 600, bottom: 400 }, 600, 400), false);
  assert.equal(coversCanvas({ left: 0, top: 0, right: 599, bottom: 400 }, 600, 400), false);
  assert.equal(coversCanvas({ left: 0, top: 0, right: 600, bottom: 399 }, 600, 400), false);
  assert.equal(coversCanvas({ left: 2, top: 2, right: 598, bottom: 398 }, 600, 400, 2), true);
  assert.equal(coversCanvas({ left: 3, top: 2, right: 598, bottom: 398 }, 600, 400, 2), false);
  assert.equal(coversCanvas(null, 600, 400), false);
});

test("polygonCoversCanvas: true only when every canvas corner is inside or within the margin", () => {
  const rect = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }];
  assert.equal(polygonCoversCanvas(rect, 600, 400), true);
  const inset = [{ x: 2, y: 2 }, { x: 598, y: 2 }, { x: 598, y: 398 }, { x: 2, y: 398 }];
  assert.equal(polygonCoversCanvas(inset, 600, 400, 0), false);
  assert.equal(polygonCoversCanvas(inset, 600, 400, 3), true);
  const tri = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 0, y: 400 }];
  assert.equal(polygonCoversCanvas(tri, 600, 400, 2), false);
  const big = [{ x: -100, y: -100 }, { x: 800, y: -100 }, { x: 800, y: 600 }, { x: -100, y: 600 }];
  assert.equal(polygonCoversCanvas(big, 600, 400), true);
});
