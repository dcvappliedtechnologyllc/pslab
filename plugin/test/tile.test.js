const test = require("node:test");
const assert = require("node:assert/strict");
const { toRgb, stitchSideBySide, tileGrid } = require("../lib/tile");

const solid = (width, height, rgb) => {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set(rgb, i * 3);
  return { data, width, height };
};
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 3, (y * img.width + x) * 3 + 3));

test("toRgb drops alpha, repeats gray, passes RGB through", () => {
  assert.deepEqual(Array.from(toRgb(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 0]), 4, 2)), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(toRgb(new Uint8Array([9, 7]), 1, 2)), [9, 9, 9, 7, 7, 7]);
  const rgb = new Uint8Array([1, 2, 3]);
  assert.equal(toRgb(rgb, 3, 1), rgb);
});

test("stitchSideBySide: left, grey gap, right", () => {
  const out = stitchSideBySide(solid(3, 2, [255, 0, 0]), solid(4, 2, [0, 0, 255]), 2);
  assert.equal(out.width, 9);
  assert.equal(out.height, 2);
  assert.equal(out.data.length, 9 * 2 * 3);
  assert.deepEqual(px(out, 0, 0), [255, 0, 0]);
  assert.deepEqual(px(out, 2, 1), [255, 0, 0]);
  assert.deepEqual(px(out, 3, 0), [128, 128, 128]);
  assert.deepEqual(px(out, 4, 1), [128, 128, 128]);
  assert.deepEqual(px(out, 5, 0), [0, 0, 255]);
  assert.deepEqual(px(out, 8, 1), [0, 0, 255]);
});

test("stitchSideBySide: default gap is 8 px; unequal heights throw", () => {
  assert.equal(stitchSideBySide(solid(1, 1, [0, 0, 0]), solid(1, 1, [0, 0, 0])).width, 10);
  assert.throws(() => stitchSideBySide(solid(1, 1, [0, 0, 0]), solid(1, 2, [0, 0, 0])), /equal heights/);
});

test("tileGrid: sheet dimensions from cols, rows, cell and gap", () => {
  const imgs = [1, 2, 3, 4, 5].map(() => solid(10, 10, [0, 0, 0]));
  const out = tileGrid(imgs, { cols: 3, cell: 10, gap: 2 });
  assert.equal(out.width, 3 * 10 + 2 * 4);
  assert.equal(out.height, 2 * 10 + 2 * 3);
  assert.equal(out.data.length, out.width * out.height * 3);
  assert.deepEqual(out.placements[4], { x: 2 + 12, y: 2 + 12, w: 10, h: 10 });
  assert.deepEqual(px(out, 0, 0), [128, 128, 128]);
  assert.deepEqual(px(out, out.width - 1, out.height - 1), [128, 128, 128]);
});

test("tileGrid: a 1x1 red pixel lands centered in its cell", () => {
  const out = tileGrid([solid(1, 1, [0, 0, 255]), solid(1, 1, [255, 0, 0])], { cols: 2, cell: 5, gap: 1, bg: 0 });
  // cell 1 starts at x = 1 + 5 + 1 = 7, y = 1; centered: +2, +2
  assert.deepEqual(out.placements[1], { x: 9, y: 3, w: 1, h: 1 });
  assert.deepEqual(px(out, 9, 3), [255, 0, 0]);
  assert.deepEqual(px(out, 3, 3), [0, 0, 255]);
  let red = 0;
  for (let i = 0; i < out.width * out.height; i++) if (out.data[i * 3] === 255) red++;
  assert.equal(red, 1);
});

test("tileGrid: letterboxing is centered; an oversize image is cut to the cell", () => {
  const out = tileGrid([solid(8, 4, [255, 255, 255]), solid(12, 3, [0, 255, 0])], { cols: 1, cell: 8, gap: 2, bg: 0 });
  assert.deepEqual(out.placements[0], { x: 2, y: 2 + 2, w: 8, h: 4 });
  assert.deepEqual(px(out, 2, 3), [0, 0, 0]);
  assert.deepEqual(px(out, 2, 4), [255, 255, 255]);
  assert.deepEqual(px(out, 9, 7), [255, 255, 255]);
  assert.deepEqual(px(out, 2, 8), [0, 0, 0]);
  // second cell starts at y = 2 + 8 + 2 = 12; 3 rows centered: +2
  assert.deepEqual(out.placements[1], { x: 2, y: 14, w: 8, h: 3 });
  assert.deepEqual(px(out, 9, 14), [0, 255, 0]);
  assert.deepEqual(px(out, 10, 14), [0, 0, 0]);
});
