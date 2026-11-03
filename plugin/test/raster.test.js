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

// ---------- mask builders (v0.2 P1) ----------

const { finishMask, lumaOf, luminanceMask, coveragePct } = require("../lib/raster");

test("lumaOf uses Rec. 709 weights", () => {
  assert.equal(lumaOf(100, 100, 100), 100);
  assert.ok(Math.abs(lumaOf(255, 0, 0) - 54.213) < 1e-9);
  assert.ok(Math.abs(lumaOf(0, 255, 0) - 182.376) < 1e-9);
});

test("luminanceMask: inclusive range, invert", () => {
  // 4x1: L = 10, 50, 51, 255
  const rgb = Uint8Array.from([10, 10, 10, 50, 50, 50, 51, 51, 51, 255, 255, 255]);
  assert.deepEqual(Array.from(luminanceMask(rgb, 4, 1, 50, 51)), [0, 255, 255, 0]);
  assert.deepEqual(Array.from(luminanceMask(rgb, 4, 1, 50, 51, 0, true)), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(luminanceMask(rgb, 4, 1, 0, 255)), [255, 255, 255, 255]);
});

test("finishMask feather matches polygonMask's blur", () => {
  const fill = new Float32Array(5).fill(0);
  fill[2] = 255;
  // r=1, edge-clamped, twice: pass 1 [0, 85, 85, 85, 0]; pass 2 [28.3, 56.7, 85, 56.7, 28.3]
  assert.deepEqual(Array.from(finishMask(fill, 5, 1, 1, false)), [28, 57, 85, 57, 28]);
  assert.deepEqual(Array.from(finishMask(fill, 5, 1, 0, true)), [255, 255, 0, 255, 255]);
});

test("coveragePct: pixels >= 128, one decimal", () => {
  assert.equal(coveragePct(Uint8Array.from([0, 127, 128, 255])), 50);
  assert.equal(coveragePct(Uint8Array.from([255, 0, 0])), 33.3);
  assert.equal(coveragePct(new Uint8Array(0)), 0);
});

const { gradientMask } = require("../lib/raster");

test("gradientMask linear: 255 at from, 0 at to, 128 at the midpoint, clamped beyond", () => {
  // 9x1, pixel centres at 0.5..8.5; from on pixel 1, to on pixel 7.
  const out = gradientMask(9, 1, { kind: "linear", from: { x: 1.5, y: 0.5 }, to: { x: 7.5, y: 0.5 } });
  assert.equal(out[1], 255); // from
  assert.equal(out[7], 0); // to
  assert.equal(out[4], 128); // midpoint: 127.5 rounds up
  assert.equal(out[0], 255); // before from: clamped
  assert.equal(out[8], 0); // past to: clamped
  assert.equal(out[2], 213); // 255 * 5/6 = 212.5
});

test("gradientMask linear along a diagonal projects onto the vector", () => {
  // from the centre of a 5x5 to its corner: 255 at centre, 0 at corner (4,4), constant along perpendiculars.
  const out = gradientMask(5, 5, { kind: "linear", from: { x: 2.5, y: 2.5 }, to: { x: 4.5, y: 4.5 } });
  assert.equal(out[2 * 5 + 2], 255);
  assert.equal(out[4 * 5 + 4], 0);
  assert.equal(out[3 * 5 + 3], 128); // midpoint
  assert.equal(out[2 * 5 + 3], out[3 * 5 + 2]); // same projection
  assert.equal(out[0], 255); // behind from: clamped
});

test("gradientMask radial: smoothstep from 255 at from to 0 at radius", () => {
  // 9x1, from on pixel 0 centre, radius 8 -> pixel 8 at distance 8.
  const out = gradientMask(9, 1, { kind: "radial", from: { x: 0.5, y: 0.5 }, radius_px: 8 });
  assert.equal(out[0], 255);
  assert.equal(out[8], 0);
  assert.equal(out[4], 128); // t = 0.5: smoothstep 0.5
  assert.equal(out[2], 215); // t = 0.25: 1 - 0.15625 = 0.84375 * 255 = 215.2
  assert.equal(out[6], 40); // t = 0.75: 1 - 0.84375 = 0.15625 * 255 = 39.8
});

test("gradientMask invert and argument errors", () => {
  const out = gradientMask(3, 1, { kind: "linear", from: { x: 0.5, y: 0.5 }, to: { x: 2.5, y: 0.5 }, invert: true });
  assert.deepEqual(Array.from(out), [0, 127, 255]); // 255 - round(127.5)
  assert.throws(() => gradientMask(3, 1, { kind: "linear", from: { x: 0, y: 0 } }), (e) => e.code === "INVALID_ARGS");
  assert.throws(() => gradientMask(3, 1, { kind: "linear", from: { x: 0, y: 0 }, to: { x: 0, y: 0 } }), (e) => e.code === "INVALID_ARGS");
  assert.throws(() => gradientMask(3, 1, { kind: "radial", from: { x: 0, y: 0 }, radius_px: 0 }), (e) => e.code === "INVALID_ARGS");
  assert.throws(() => gradientMask(3, 1, { kind: "spiral", from: { x: 0, y: 0 } }), (e) => e.code === "INVALID_ARGS");
});

const { sampleMean, colorMask } = require("../lib/raster");

test("sampleMean: 5x5 box clipped at the corner, rounded", () => {
  // 3x3 canvas: grey 0/30/60 by column, centre pixel red.
  const rgb = new Uint8Array(27);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) rgb.set([30 * x, 30 * x, 30 * x], (y * 3 + x) * 3);
  rgb.set([255, 0, 0], 4 * 3);
  // r: (3*(0+60) + 30+30+255)/9 = 55; g, b: (180 + 60)/9 = 26.7 -> 27
  assert.deepEqual(sampleMean(rgb, 3, 3, 0.9, 0.2), { r: 55, g: 27, b: 27 });
  assert.deepEqual(sampleMean(rgb, 3, 3, 2, 2, 0), { r: 60, g: 60, b: 60 });
  assert.throws(() => sampleMean(rgb, 3, 3, 10, 10), (e) => e.code === "OUT_OF_BOUNDS");
});

test("colorMask: max channel distance, full to fuzz, linear to 0 at 2*fuzz", () => {
  // distances from (100,100,100): 0, 20, 30, 40, 50 (one channel off)
  const rgb = Uint8Array.from([100, 100, 100, 100, 120, 100, 70, 100, 100, 100, 100, 140, 150, 100, 100]);
  assert.deepEqual(Array.from(colorMask(rgb, 5, 1, { r: 100, g: 100, b: 100 }, 20)), [255, 255, 128, 0, 0]);
  assert.deepEqual(Array.from(colorMask(rgb, 5, 1, { r: 100, g: 100, b: 100 }, 0)), [255, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(colorMask(rgb, 5, 1, { r: 100, g: 100, b: 100 }, 20, 0, true)), [0, 0, 127, 255, 255]);
});

test("luminanceMask: integer bounds are inclusive despite float error in the weights", () => {
  const white = new Uint8Array(4 * 3).fill(255);
  assert.equal(coveragePct(luminanceMask(white, 4, 1, 255, 255)), 100);
  const grey10 = new Uint8Array(3).fill(10);
  assert.deepEqual(Array.from(luminanceMask(grey10, 1, 1, 10, 20)), [255]);
  // every neutral grey v lands inside [v, v]
  const greys = new Uint8Array(256 * 3);
  for (let v = 0; v < 256; v++) greys.fill(v, v * 3, v * 3 + 3);
  for (let v = 0; v < 256; v++) assert.equal(luminanceMask(greys, 256, 1, v, v)[v], 255, `grey ${v}`);
});
