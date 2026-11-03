const test = require("node:test");
const assert = require("node:assert/strict");
const masks = require("../lib/actions/masks");
const raster = require("../lib/raster");

const W = 8;
const H = 6;

// Composite used by every test: column x has grey level 30 * x (0..210),
// except pixel (1, 1) which is pure red.
function compositeAt(x, y) {
  if (x === 1 && y === 1) return [255, 0, 0];
  const v = 30 * x;
  return [v, v, v];
}
function fullComposite(w = W, h = H) {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(compositeAt(x, y), (y * w + x) * 3);
  return out;
}

// Stub ps: modal and history recording, getPixels serves compositeAt for the
// requested bounds, mask I/O and encode are recorded, every imageData's
// dispose is logged by kind.
function makeStub({ w = W, h = H, hasMask = true, maskBuf = null, components = 3, pixel = compositeAt } = {}) {
  const calls = [];
  const doc = { id: 1, name: "a.psd", width: w, height: h, layers: [{ id: 10, name: "Background" }, { id: 11, name: "Fix" }] };
  const other = { id: 2, name: "b.psd", width: w, height: h, layers: [{ id: 20, name: "Other" }] };
  let active = doc;
  const disposed = (kind) => () => calls.push(["dispose", kind]);
  return {
    calls,
    doc,
    other,
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
        return descs.map(() => ({ hasUserMask: hasMask }));
      },
    },
    imaging: {
      async getPixels(o) {
        calls.push(["getPixels", o]);
        const b = o.sourceBounds;
        const bw = b.right - b.left;
        const bh = b.bottom - b.top;
        return {
          imageData: {
            width: bw,
            height: bh,
            components,
            async getData(g) {
              calls.push(["getData", g]);
              const buf = new Uint8Array(bw * bh * 3);
              for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) buf.set(pixel(b.left + x, b.top + y), (y * bw + x) * 3);
              return buf;
            },
            dispose: disposed("pixels"),
          },
        };
      },
      async getLayerMask(o) {
        calls.push(["getLayerMask", o]);
        const tw = o.targetSize ? o.targetSize.width ?? Math.round((w * o.targetSize.height) / h) : w;
        const th = o.targetSize ? o.targetSize.height ?? Math.round((h * o.targetSize.width) / w) : h;
        return {
          imageData: {
            width: tw,
            height: th,
            components: 1,
            async getData() {
              return maskBuf ?? new Uint8Array(tw * th).map((_, i) => i % 256);
            },
            dispose: disposed("mask"),
          },
        };
      },
      async createImageDataFromBuffer(buf, opts) {
        calls.push(["createImageDataFromBuffer", opts]);
        return { buf, opts, width: opts.width, height: opts.height, dispose: disposed("created") };
      },
      async putLayerMask(o) {
        calls.push(["putLayerMask", o]);
      },
      async encodeImageData(o) {
        calls.push(["encodeImageData", o]);
        return "SlBFRw==";
      },
    },
  };
}

const find = (ps, name) => ps.calls.find((c) => c[0] === name);
const all = (ps, name) => ps.calls.filter((c) => c[0] === name);
const historyName = (ps) => find(ps, "suspendHistory")[1].name;
const modalCount = (ps) => all(ps, "executeAsModal").length;
const written = (ps) => find(ps, "putLayerMask")[1].imageData.buf;
const disposals = (ps) => all(ps, "dispose").map((c) => c[1]);

// ---------- mask_from_luminance ----------

test("mask_from_luminance: thresholds L, writes the mask, one history step", async () => {
  const ps = makeStub();
  // L of grey v is v; red is 0.2126 * 255 = 54.2. 60..150 keeps columns 2..5.
  const r = await masks.mask_from_luminance(ps, { layer: 11, min_l: 60, max_l: 150 });
  assert.equal(historyName(ps), "Claude: mask_from_luminance, L 60..150");
  assert.equal(modalCount(ps), 1);
  const buf = written(ps);
  assert.deepEqual(buf, raster.luminanceMask(fullComposite(), W, H, 60, 150));
  for (let x = 0; x < W; x++) assert.equal(buf[2 * W + x], x >= 2 && x <= 5 ? 255 : 0, `column ${x}`);
  assert.deepEqual(r, { ok: true, coverage_pct: 50 });
  const px = find(ps, "getPixels")[1];
  assert.deepEqual(px.sourceBounds, { left: 0, top: 0, right: W, bottom: H });
  assert.equal(px.targetSize, undefined);
  assert.equal(px.layerID, undefined);
  const put = find(ps, "putLayerMask")[1];
  assert.deepEqual([put.documentID, put.layerID, put.kind, put.replace], [1, 11, "user", true]);
  const create = find(ps, "createImageDataFromBuffer")[1];
  assert.deepEqual([create.components, create.colorSpace, create.width, create.height], [1, "Grayscale", W, H]);
  assert.deepEqual(disposals(ps), ["pixels", "created"]);
  assert.deepEqual(find(ps, "resumeHistory"), ["resumeHistory", 7, true]);
});

test("mask_from_luminance: default max_l, invert and feather", async () => {
  const ps = makeStub();
  const r = await masks.mask_from_luminance(ps, { layer: 11, min_l: 100, feather_px: 1, invert: true });
  assert.equal(historyName(ps), "Claude: mask_from_luminance, L 100..255");
  assert.deepEqual(written(ps), raster.luminanceMask(fullComposite(), W, H, 100, 255, 1, true));
  assert.equal(r.coverage_pct, raster.coveragePct(written(ps)));
});

test("mask_from_luminance reads in 1024-row bands when the composite exceeds the limit", async () => {
  const h = 2500;
  const ps = makeStub({ w: 2, h });
  masks.setBandLimit(2 * h * 3 - 1);
  try {
    await masks.mask_from_luminance(ps, { layer: 11, min_l: 0 });
  } finally {
    masks.setBandLimit(null);
  }
  assert.deepEqual(
    all(ps, "getPixels").map((c) => [c[1].sourceBounds.top, c[1].sourceBounds.bottom]),
    [[0, 1024], [1024, 2048], [2048, 2500]],
  );
  assert.deepEqual(disposals(ps), ["pixels", "pixels", "pixels", "created"]);
  assert.equal(written(ps).length, 2 * h);
});

test("banded read: composite and written mask match a single read across three bands", async () => {
  // Every row differs (row index spread over R and G) so a misplaced band shows.
  const w = 3;
  const h = 2500;
  const pixel = (x, y) => [y % 256, (y >> 3) % 256, 40 * x];
  const reference = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) reference.set(pixel(x, y), (y * w + x) * 3);
  const ps = makeStub({ w, h, pixel });
  masks.setBandLimit(0);
  let banded;
  try {
    banded = await masks.readComposite(ps, ps.doc, w, h);
    await masks.mask_from_luminance(ps, { layer: 11, min_l: 60, max_l: 180 });
  } finally {
    masks.setBandLimit(null);
  }
  assert.equal(all(ps, "getPixels").length, 6); // 3 bands for readComposite, 3 for the tool
  assert.deepEqual(banded, reference);
  assert.deepEqual(written(ps), raster.luminanceMask(reference, w, h, 60, 180));
});

test("mask_from_luminance validates before any modal", async () => {
  const cases = [
    [{ layer: 11, min_l: -1 }, "INVALID_ARGS"],
    [{ layer: 11, min_l: 10, max_l: 256 }, "INVALID_ARGS"],
    [{ layer: 11, min_l: 200, max_l: 100 }, "INVALID_ARGS"],
    [{ layer: 11, min_l: 0, feather_px: -2 }, "INVALID_ARGS"],
    [{ layer: 99, min_l: 0 }, "NO_LAYER"],
  ];
  for (const [args, code] of cases) {
    const ps = makeStub();
    await assert.rejects(masks.mask_from_luminance(ps, args), (e) => e.code === code, JSON.stringify(args));
    assert.equal(modalCount(ps), 0);
  }
});

test("mask_from_luminance on another doc activates it and restores the active doc", async () => {
  const ps = makeStub();
  await masks.mask_from_luminance(ps, { doc: 2, layer: 20, min_l: 0 });
  assert.equal(find(ps, "suspendHistory")[1].documentID, 2);
  assert.deepEqual(all(ps, "activate"), [["activate", 2], ["activate", 1]]);
  assert.equal(find(ps, "getPixels")[1].documentID, 2);
  assert.equal(find(ps, "putLayerMask")[1].documentID, 2);
});

test("mask_from_luminance rolls back and disposes when the composite is not RGB", async () => {
  const ps = makeStub({ components: 1 });
  await assert.rejects(masks.mask_from_luminance(ps, { layer: 11, min_l: 0 }), (e) => e.code === "UNSUPPORTED_PIXELS");
  assert.deepEqual(find(ps, "resumeHistory"), ["resumeHistory", 7, false]);
  assert.deepEqual(disposals(ps), ["pixels"]);
  assert.equal(find(ps, "putLayerMask"), undefined);
});

// ---------- mask_gradient ----------

test("mask_gradient linear writes gradientMask's buffer without reading pixels", async () => {
  const ps = makeStub();
  const spec = { kind: "linear", from: { x: 0.5, y: 0.5 }, to: { x: 6.5, y: 0.5 } };
  const r = await masks.mask_gradient(ps, { layer: 11, ...spec });
  assert.deepEqual(r, { ok: true });
  assert.equal(historyName(ps), "Claude: mask_gradient, linear");
  assert.deepEqual(written(ps), raster.gradientMask(W, H, spec));
  assert.deepEqual(Array.from(written(ps).subarray(0, W)), [255, 213, 170, 128, 85, 42, 0, 0]);
  assert.equal(find(ps, "getPixels"), undefined);
  assert.deepEqual(disposals(ps), ["created"]);
  const put = find(ps, "putLayerMask")[1];
  assert.deepEqual([put.documentID, put.layerID, put.kind, put.replace], [1, 11, "user", true]);
});

test("mask_gradient radial with invert", async () => {
  const ps = makeStub();
  const spec = { kind: "radial", from: { x: 4, y: 3 }, radius_px: 3, invert: true };
  await masks.mask_gradient(ps, { layer: 11, ...spec });
  assert.equal(historyName(ps), "Claude: mask_gradient, radial");
  assert.deepEqual(written(ps), raster.gradientMask(W, H, spec));
});

test("mask_gradient validates before any modal", async () => {
  const cases = [
    { layer: 11, kind: "conic", from: { x: 0, y: 0 } },
    { layer: 11, kind: "linear", from: { x: 0, y: 0 } },
    { layer: 11, kind: "linear", from: { x: 1, y: 1 }, to: { x: 1, y: 1 } },
    { layer: 11, kind: "radial", from: { x: 0, y: 0 } },
    { layer: 11, kind: "radial", from: { x: 0, y: 0 }, radius_px: 0 },
    { layer: 11, kind: "radial", radius_px: 4 },
  ];
  for (const args of cases) {
    const ps = makeStub();
    await assert.rejects(masks.mask_gradient(ps, args), (e) => e.code === "INVALID_ARGS", JSON.stringify(args));
    assert.equal(modalCount(ps), 0);
  }
  const ps = makeStub();
  await assert.rejects(masks.mask_gradient(ps, { layer: 99, kind: "radial", from: { x: 0, y: 0 }, radius_px: 2 }), (e) => e.code === "NO_LAYER");
  assert.equal(modalCount(ps), 0);
});

// ---------- mask_from_color ----------

test("mask_from_color with sample: 5x5 mean in a read modal, then one history step", async () => {
  const ps = makeStub();
  // Columns 3..7 grey 90..210 around (5.5, 3.2): mean 150.
  const r = await masks.mask_from_color(ps, { layer: 11, sample: { x: 5.5, y: 3.2 } });
  assert.deepEqual(all(ps, "executeAsModal").map((c) => c[1]), ["Sample colour", "Claude: mask_from_color, rgb(150,150,150) ±40"]);
  assert.equal(historyName(ps), "Claude: mask_from_color, rgb(150,150,150) ±40");
  const reads = all(ps, "getPixels").map((c) => c[1].sourceBounds);
  assert.deepEqual(reads, [{ left: 3, top: 1, right: 8, bottom: 6 }, { left: 0, top: 0, right: W, bottom: H }]);
  const buf = written(ps);
  assert.deepEqual(buf, raster.colorMask(fullComposite(), W, H, { r: 150, g: 150, b: 150 }, 40));
  // grey 120..180 within 40: 255; 90 and 210 at distance 60: half way to 2*40 -> 128; 60 and below: 0
  assert.deepEqual(Array.from(buf.subarray(3 * W, 4 * W)), [0, 0, 0, 128, 255, 255, 255, 128]);
  assert.deepEqual(r, { ok: true, coverage_pct: 62.5, sampled_rgb: { r: 150, g: 150, b: 150 } });
  assert.deepEqual(disposals(ps), ["pixels", "pixels", "created"]);
});

test("mask_from_color with rgb: no sample read, fuzziness, feather and invert", async () => {
  const ps = makeStub();
  const r = await masks.mask_from_color(ps, { layer: 11, rgb: { r: 255, g: 0, b: 0 }, fuzziness: 0, feather_px: 1, invert: true });
  assert.equal(modalCount(ps), 1);
  assert.equal(historyName(ps), "Claude: mask_from_color, rgb(255,0,0) ±0");
  assert.deepEqual(written(ps), raster.colorMask(fullComposite(), W, H, { r: 255, g: 0, b: 0 }, 0, 1, true));
  assert.deepEqual(r.sampled_rgb, { r: 255, g: 0, b: 0 });
  assert.equal(r.coverage_pct, raster.coveragePct(written(ps)));
});

test("mask_from_color validates before any modal", async () => {
  const cases = [
    [{ layer: 11 }, "INVALID_ARGS"],
    [{ layer: 11, sample: { x: 1, y: 1 }, rgb: { r: 0, g: 0, b: 0 } }, "INVALID_ARGS"],
    [{ layer: 11, rgb: { r: 256, g: 0, b: 0 } }, "INVALID_ARGS"],
    [{ layer: 11, rgb: { r: 0, g: 0 } }, "INVALID_ARGS"],
    [{ layer: 11, rgb: { r: 0, g: 0, b: 0 }, fuzziness: 300 }, "INVALID_ARGS"],
    [{ layer: 11, rgb: { r: 0, g: 0, b: 0 }, feather_px: -1 }, "INVALID_ARGS"],
    [{ layer: 11, sample: { x: W, y: 0 } }, "OUT_OF_BOUNDS"],
    [{ layer: 11, sample: { x: 0, y: -0.5 } }, "OUT_OF_BOUNDS"],
    [{ layer: 99, rgb: { r: 0, g: 0, b: 0 } }, "NO_LAYER"],
  ];
  for (const [args, code] of cases) {
    const ps = makeStub();
    await assert.rejects(masks.mask_from_color(ps, args), (e) => e.code === code, JSON.stringify(args));
    assert.equal(modalCount(ps), 0);
  }
});

// ---------- preview_mask ----------

test("preview_mask: downscaled mask tripled to RGB, encoded, both disposed, no history", async () => {
  const w = 3000;
  const h = 1500;
  const ps = makeStub({ w, h });
  const r = await masks.preview_mask(ps, { layer: 11, max_px: 300 });
  assert.deepEqual(all(ps, "executeAsModal").map((c) => c[1]), ["Preview Mask"]);
  assert.equal(find(ps, "suspendHistory"), undefined);
  const get = find(ps, "getLayerMask")[1];
  assert.deepEqual(get, {
    documentID: 1,
    layerID: 11,
    kind: "user",
    sourceBounds: { left: 0, top: 0, right: w, bottom: h },
    targetSize: { width: 300 },
  });
  const create = find(ps, "createImageDataFromBuffer");
  assert.deepEqual(create[1], { width: 300, height: 150, components: 3, colorSpace: "RGB", chunky: true });
  const enc = find(ps, "encodeImageData")[1];
  assert.equal(enc.base64, true);
  const rgb = enc.imageData.buf;
  assert.equal(rgb.length, 300 * 150 * 3);
  // stub mask value at i is i % 256; each value appears three times
  assert.deepEqual(Array.from(rgb.subarray(0, 9)), [0, 0, 0, 1, 1, 1, 2, 2, 2]);
  assert.deepEqual(Array.from(rgb.subarray(3 * 300, 3 * 301)), [300 % 256, 300 % 256, 300 % 256]);
  assert.deepEqual(r, { has_mask: true, jpeg_base64: "SlBFRw==", preview: { w: 300, h: 150 }, scale: 10 });
  assert.deepEqual(disposals(ps).sort(), ["created", "mask"]);
});

test("preview_mask: portrait limits height; small docs are read at full size", async () => {
  const ps = makeStub({ w: 1000, h: 2000 });
  const r = await masks.preview_mask(ps, { layer: 11 });
  assert.deepEqual(find(ps, "getLayerMask")[1].targetSize, { height: 1000 });
  assert.deepEqual(r.preview, { w: 500, h: 1000 });
  assert.equal(r.scale, 2);
  const small = makeStub();
  const r2 = await masks.preview_mask(small, { layer: 11, max_px: 200 });
  assert.equal(find(small, "getLayerMask")[1].targetSize, undefined);
  assert.equal(r2.scale, 1);
});

test("preview_mask without a user mask returns has_mask false and reads nothing", async () => {
  const ps = makeStub({ hasMask: false });
  const r = await masks.preview_mask(ps, { layer: 11 });
  assert.deepEqual(r, { has_mask: false });
  assert.equal(find(ps, "getLayerMask"), undefined);
  assert.equal(find(ps, "encodeImageData"), undefined);
});

test("preview_mask converts a 16-bit mask to bytes", async () => {
  const ps = makeStub({ maskBuf: Uint16Array.from({ length: W * H }, (_, i) => (i === 0 ? 32768 : 0)) });
  await masks.preview_mask(ps, { layer: 11 });
  const rgb = find(ps, "encodeImageData")[1].imageData.buf;
  assert.deepEqual(Array.from(rgb.subarray(0, 6)), [255, 255, 255, 0, 0, 0]);
});

test("preview_mask disposes the mask when encoding fails", async () => {
  const ps = makeStub();
  ps.imaging.encodeImageData = async () => {
    throw new Error("encode broke");
  };
  await assert.rejects(masks.preview_mask(ps, { layer: 11 }), /encode broke/);
  assert.deepEqual(disposals(ps).sort(), ["created", "mask"]);
});

test("preview_mask validates before any modal", async () => {
  for (const [args, code] of [
    [{ layer: 11, max_px: 100 }, "INVALID_ARGS"],
    [{ layer: 11, max_px: 5000 }, "INVALID_ARGS"],
    [{ layer: 99 }, "NO_LAYER"],
    [{ doc: 9, layer: 11 }, "NO_DOCUMENT"],
  ]) {
    const ps = makeStub();
    await assert.rejects(masks.preview_mask(ps, args), (e) => e.code === code, JSON.stringify(args));
    assert.equal(modalCount(ps), 0);
  }
});
