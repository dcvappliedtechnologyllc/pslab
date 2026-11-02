const test = require("node:test");
const assert = require("node:assert/strict");
const { rasterizeStrokes, polygonMask, imageDataFromMask } = require("../lib/raster");

const W = 64;
const H = 64;
const at = (buf, w, x, y) => buf[y * w + x];

// Pixel (x, y) has its center at (x + 0.5, y + 0.5), so a dab at (32.5, 32.5)
// sits exactly on pixel (32, 32).
const dot = (opacity) => ({
  points: [{ x: 32.5, y: 32.5 }],
  size_px: 32, // radius 16
  hardness: 0,
  opacity,
});

test("rasterizeStrokes: soft round dab, white on black", () => {
  const base = new Uint8Array(W * H); // all black
  const out = rasterizeStrokes(W, H, [dot(1)], "white", base);
  assert.equal(out.length, W * H);
  assert.equal(at(out, W, 32, 32), 255); // center
  assert.equal(at(out, W, 48, 32), 0); // exactly at radius 16
  assert.equal(at(out, W, 50, 32), 0); // outside
  const half = at(out, W, 40, 32); // distance 8 = half radius
  assert.ok(Math.abs(half - 128) <= 10, `half radius ${half}`);
  assert.equal(at(base, W, 32, 32), 0, "base not mutated");
});

test("rasterizeStrokes: opacity 0.7 center", () => {
  const out = rasterizeStrokes(W, H, [dot(0.7)], "white", new Uint8Array(W * H));
  const c = at(out, W, 32, 32);
  assert.ok(Math.abs(c - 178) <= 2, `center ${c}`);
});

test("rasterizeStrokes: null base is white, black paints down", () => {
  const out = rasterizeStrokes(W, H, [dot(1)], "black", null);
  assert.equal(at(out, W, 32, 32), 0);
  assert.equal(at(out, W, 0, 0), 255);
});

test("rasterizeStrokes: overlapping strokes accumulate like brush passes", () => {
  const out = rasterizeStrokes(W, H, [dot(0.7), dot(0.7)], "white", new Uint8Array(W * H));
  // 255 * (1 - 0.3 * 0.3) = 232.05
  assert.ok(Math.abs(at(out, W, 32, 32) - 232) <= 1);
});

test("rasterizeStrokes: polyline covers the segment between points", () => {
  const stroke = {
    points: [{ x: 8.5, y: 32.5 }, { x: 56.5, y: 32.5 }],
    size_px: 8,
    hardness: 1,
    opacity: 1,
  };
  const out = rasterizeStrokes(W, H, [stroke], "white", new Uint8Array(W * H));
  for (let x = 8; x <= 56; x++) assert.equal(at(out, W, x, 32), 255, `x=${x}`);
  assert.equal(at(out, W, 32, 20), 0);
});

test("stroke off canvas is clipped", () => {
  const stroke = {
    points: [{ x: -50, y: -50 }, { x: 200, y: 200 }],
    size_px: 300,
    hardness: 0.5,
    opacity: 1,
  };
  const out = rasterizeStrokes(W, H, [stroke], "white", new Uint8Array(W * H));
  assert.equal(out.length, W * H);
  assert.ok(out.some((v) => v > 0));
});

test("polygonMask: square, no feather", () => {
  const sq = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }];
  const m = polygonMask(32, 32, sq, 0, false);
  assert.equal(m.length, 32 * 32);
  assert.equal(at(m, 32, 15, 15), 255);
  assert.equal(at(m, 32, 10, 10), 255);
  assert.equal(at(m, 32, 19, 19), 255);
  assert.equal(at(m, 32, 20, 15), 0);
  assert.equal(at(m, 32, 9, 15), 0);
  assert.equal(at(m, 32, 5, 5), 0);
  let count = 0;
  for (const v of m) if (v === 255) count++;
  assert.equal(count, 100);
});

test("polygonMask: feather 3 softens the edge", () => {
  const sq = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }];
  const m = polygonMask(32, 32, sq, 3, false);
  const edge = at(m, 32, 10, 15);
  assert.ok(edge > 60 && edge < 200, `edge ${edge}`);
  assert.equal(at(m, 32, 0, 0), 0);
});

test("polygonMask: invert flips", () => {
  const sq = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }];
  const a = polygonMask(32, 32, sq, 3, false);
  const b = polygonMask(32, 32, sq, 3, true);
  for (let i = 0; i < a.length; i++) assert.equal(b[i], 255 - a[i]);
  assert.equal(at(b, 32, 0, 0), 255);
  assert.equal(at(polygonMask(32, 32, sq, 0, true), 32, 15, 15), 0);
});

test("polygonMask: even-odd fill leaves a self-overlap hole", () => {
  // Two overlapping squares traced as one ring: overlap region is crossed twice.
  const pts = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 },
    { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }, { x: 10, y: 10 },
  ];
  const m = polygonMask(32, 32, pts, 0, false);
  assert.equal(at(m, 32, 5, 5), 255);
  assert.equal(at(m, 32, 15, 15), 0);
  assert.equal(at(m, 32, 25, 25), 255);
});

test("polygonMask: fewer than 3 points throws INVALID_POLYGON", () => {
  assert.throws(
    () => polygonMask(8, 8, [{ x: 0, y: 0 }, { x: 4, y: 4 }], 0, false),
    (e) => e.code === "INVALID_POLYGON",
  );
});

test("imageDataFromMask passes grayscale chunky options", () => {
  let call;
  const ps = { imaging: { createImageDataFromBuffer: (b, o) => ((call = { b, o }), "IMG") } };
  const buf = new Uint8Array(6);
  assert.equal(imageDataFromMask(ps, buf, 3, 2), "IMG");
  assert.equal(call.b, buf);
  assert.deepEqual(call.o, {
    width: 3,
    height: 2,
    components: 1,
    colorSpace: "Grayscale",
    colorProfile: "Gray Gamma 2.2",
    chunky: true,
  });
});

test("rasterizeStrokes: missing hardness/opacity default to 0 and 1", () => {
  const pts = [{ x: 10.5, y: 10.5 }];
  const explicit = rasterizeStrokes(20, 20, [{ points: pts, size_px: 8, hardness: 0, opacity: 1 }], "black");
  const defaulted = rasterizeStrokes(20, 20, [{ points: pts, size_px: 8 }], "black");
  const nan = rasterizeStrokes(20, 20, [{ points: pts, size_px: 8, hardness: NaN, opacity: NaN }], "black");
  assert.deepEqual(defaulted, explicit);
  assert.deepEqual(nan, explicit);
  assert.equal(explicit[10 * 20 + 10], 0);
});

test("rasterizeStrokes: non-finite points are skipped and a non-finite size skips the stroke", () => {
  const clean = rasterizeStrokes(20, 20, [{ points: [{ x: 5, y: 5 }, { x: 15, y: 5 }], size_px: 4, hardness: 1, opacity: 1 }], "black");
  const dirty = rasterizeStrokes(
    20,
    20,
    [{ points: [{ x: 5, y: 5 }, { x: NaN, y: 3 }, { x: 15, y: Infinity }, null, { x: 15, y: 5 }], size_px: 4, hardness: 1, opacity: 1 }],
    "black",
  );
  assert.deepEqual(dirty, clean);
  const white = new Uint8Array(400).fill(255);
  for (const size_px of [NaN, Infinity, undefined]) {
    assert.deepEqual(rasterizeStrokes(20, 20, [{ points: [{ x: 5, y: 5 }], size_px, hardness: 1, opacity: 1 }], "black"), white);
  }
  assert.deepEqual(rasterizeStrokes(20, 20, [{ points: [{ x: NaN, y: 5 }], size_px: 4 }], "black"), white);
});
