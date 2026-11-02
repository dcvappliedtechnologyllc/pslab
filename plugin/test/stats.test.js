const test = require("node:test");
const assert = require("node:assert/strict");
const { regionStats, clampBbox } = require("../lib/stats");

function fill(w, h, pixel) {
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) out.set(pixel(i), i * 3);
  return out;
}

test("regionStats: half white, half black 4x4", () => {
  const rgb = fill(4, 4, (i) => (i < 8 ? [255, 255, 255] : [0, 0, 0]));
  const s = regionStats(rgb, 4, 4);
  assert.equal(s.clipped_high_pct, 50.0);
  assert.equal(s.clipped_low_pct, 50.0);
  assert.equal(s.mean.l, 127.5);
  assert.deepEqual([s.mean.r, s.mean.g, s.mean.b], [127.5, 127.5, 127.5]);
  assert.equal(s.px_sampled, 16);
  assert.equal(s.histogram_l.length, 32);
  assert.equal(s.histogram_l[0], 8);
  assert.equal(s.histogram_l[31], 8);
  assert.equal(s.histogram_l.reduce((a, b) => a + b, 0), 16);
});

test("regionStats: luminance weights and one-decimal rounding", () => {
  // pure red: l = 0.2126*255 = 54.213 -> 54.2, bin floor(54.213/8) = 6
  const s = regionStats(fill(3, 1, () => [255, 0, 0]), 3, 1);
  assert.deepEqual(s.mean, { r: 255, g: 0, b: 0, l: 54.2 });
  assert.equal(s.histogram_l[6], 3);
  assert.equal(s.clipped_high_pct, 0);
  assert.equal(s.clipped_low_pct, 0);
});

test("regionStats: clipping thresholds are inclusive and percentages round to one decimal", () => {
  // 1 of 3 at l=250 (high), 1 of 3 at l=5 (low), 1 at 251? no: 1 mid
  const vals = [250, 5, 128];
  const s = regionStats(fill(3, 1, (i) => [vals[i], vals[i], vals[i]]), 3, 1);
  assert.equal(s.clipped_high_pct, 33.3);
  assert.equal(s.clipped_low_pct, 33.3);
  const t = regionStats(fill(2, 1, (i) => [[249, 249, 249], [6, 6, 6]][i]), 2, 1);
  assert.equal(t.clipped_high_pct, 0);
  assert.equal(t.clipped_low_pct, 0);
});

test("clampBbox clamps to the canvas and rounds to integers", () => {
  assert.deepEqual(clampBbox({ left: -10, top: 0, right: 4000, bottom: 50 }, 3000, 2000), {
    left: 0,
    top: 0,
    right: 3000,
    bottom: 50,
  });
  assert.deepEqual(clampBbox({ left: 10.4, top: 5.6, right: 100.5, bottom: 2500 }, 3000, 2000), {
    left: 10,
    top: 6,
    right: 101,
    bottom: 2000,
  });
});

test("clampBbox throws EMPTY_REGION when nothing is left", () => {
  for (const b of [
    { left: 3000, top: 0, right: 3100, bottom: 10 },
    { left: 10, top: 10, right: 10, bottom: 20 },
    { left: 50, top: 0, right: 20, bottom: 10 },
    { left: 0, top: -50, right: 10, bottom: -1 },
  ]) {
    assert.throws(() => clampBbox(b, 3000, 2000), (e) => e.code === "EMPTY_REGION");
  }
});
