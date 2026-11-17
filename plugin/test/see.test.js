const test = require("node:test");
const assert = require("node:assert/strict");
const { render_preview, region_stats, open_document } = require("../lib/actions/see");

// Stub ps: executeAsModal runs the callback; imaging records calls and
// returns a solid buffer of the requested (or given) size.
function makeStub({ docs, out = null, components = 3, pixel = [255, 255, 255] } = {}) {
  docs = docs ?? [{ id: 5, name: "a.psd", width: 3000, height: 2000 }];
  const calls = [];
  const disposed = [];
  return {
    calls,
    disposed,
    app: {
      documents: docs,
      get activeDocument() {
        return docs[0] ?? null;
      },
    },
    core: {
      async executeAsModal(fn, options) {
        calls.push(["executeAsModal", options.commandName]);
        return fn({ hostControl: {} });
      },
    },
    imaging: {
      async getPixels(opts) {
        calls.push(["getPixels", opts]);
        const sb = opts.sourceBounds;
        const rw = sb.right - sb.left;
        const rh = sb.bottom - sb.top;
        let w = rw;
        let h = rh;
        if (out) [w, h] = out;
        else if (opts.targetSize && opts.targetSize.width) [w, h] = [opts.targetSize.width, Math.round((rh * opts.targetSize.width) / rw)];
        else if (opts.targetSize && opts.targetSize.height) [w, h] = [Math.round((rw * opts.targetSize.height) / rh), opts.targetSize.height];
        const imageData = {
          width: w,
          height: h,
          components,
          getData(o) {
            calls.push(["getData", o]);
            const buf = new Uint8Array(w * h * components);
            for (let i = 0; i < w * h; i++) buf.set(pixel.slice(0, components), i * components);
            return buf;
          },
          dispose() {
            disposed.push(imageData);
          },
        };
        return { imageData, sourceBounds: sb };
      },
      async encodeImageData(opts) {
        calls.push(["encodeImageData", { base64: opts.base64 }]);
        return "SlBFRw==";
      },
    },
  };
}

const getPixelsOpts = (ps) => ps.calls.find((c) => c[0] === "getPixels")[1];

test("render_preview clamps region to canvas and reports scale", async () => {
  const ps = makeStub({ out: [100, 50] });
  const r = await render_preview(ps, { region: { left: -10, top: 0, right: 4000, bottom: 50 } });
  assert.deepEqual(r.region, { left: 0, top: 0, right: 3000, bottom: 50 });
  assert.equal(r.scale, 30);
  assert.deepEqual(r.preview, { w: 100, h: 50 });
  assert.equal(r.jpeg_base64, "SlBFRw==");
  const o = getPixelsOpts(ps);
  assert.equal(o.documentID, 5);
  assert.equal(o.layerID, undefined);
  assert.deepEqual(o.sourceBounds, { left: 0, top: 0, right: 3000, bottom: 50 });
  // 3000 / 1500 is an exact ratio (bug 9), so one pixel less is asked for
  assert.deepEqual(o.targetSize, { width: 1499 });
  assert.equal(o.applyAlpha, true);
  assert.equal(o.componentSize, 8);
  assert.equal(ps.disposed.length, 1);
  assert.deepEqual(ps.calls[0], ["executeAsModal", "Render Preview"]);
});

test("render_preview scale is exact when no downscale", async () => {
  const ps = makeStub();
  const r = await render_preview(ps, { region: { left: 100, top: 100, right: 900, bottom: 500 }, max_px: 1500 });
  assert.equal(r.scale, 1);
  assert.deepEqual(r.preview, { w: 800, h: 400 });
  assert.equal("targetSize" in getPixelsOpts(ps), false);
});

test("render_preview defaults to whole canvas, downscales the long edge, scale unrounded", async () => {
  const ps = makeStub({ docs: [{ id: 5, width: 2000, height: 3000 }] });
  const r = await render_preview(ps, {});
  assert.deepEqual(r.region, { left: 0, top: 0, right: 2000, bottom: 3000 });
  assert.deepEqual(getPixelsOpts(ps).targetSize, { height: 1499 });
  assert.deepEqual(r.preview, { w: 999, h: 1499 });
  assert.equal(r.scale, 2000 / 999);

  const ps2 = makeStub({ out: [1500, 1000], docs: [{ id: 5, width: 3001, height: 2000 }] });
  const r2 = await render_preview(ps2, {});
  assert.equal(r2.scale, 3001 / 1500);
});

test("render_preview targets a document by id and errors when missing", async () => {
  const docs = [
    { id: 5, width: 3000, height: 2000 },
    { id: 9, width: 400, height: 300 },
  ];
  const ps = makeStub({ docs });
  const r = await render_preview(ps, { doc: 9 });
  assert.equal(getPixelsOpts(ps).documentID, 9);
  assert.deepEqual(r.region, { left: 0, top: 0, right: 400, bottom: 300 });
  await assert.rejects(render_preview(ps, { doc: 77 }), (e) => e.code === "NO_DOCUMENT");
  await assert.rejects(render_preview(makeStub({ docs: [] }), {}), (e) => e.code === "NO_DOCUMENT");
});

test("render_preview disposes imageData when encoding fails", async () => {
  const ps = makeStub();
  ps.imaging.encodeImageData = async () => {
    throw new Error("encode failed");
  };
  await assert.rejects(render_preview(ps, {}), /encode failed/);
  assert.equal(ps.disposed.length, 1);
});

test("render_preview rejects an empty region with EMPTY_REGION", async () => {
  const ps = makeStub();
  await assert.rejects(
    render_preview(ps, { region: { left: 3500, top: 0, right: 3600, bottom: 10 } }),
    (e) => e.code === "EMPTY_REGION",
  );
});

test("region_stats reads composite at min(512, width) and returns stats with clamped bbox", async () => {
  const ps = makeStub({ pixel: [255, 255, 255] });
  const r = await region_stats(ps, { bbox: { left: -5, top: 0, right: 1024, bottom: 2100 } });
  const o = getPixelsOpts(ps);
  assert.deepEqual(o.sourceBounds, { left: 0, top: 0, right: 1024, bottom: 2000 });
  assert.deepEqual(o.targetSize, { width: 511 }); // 1024 / 512 would be exact (bug 9)
  assert.equal(o.componentSize, 8);
  assert.equal(o.applyAlpha, true);
  assert.equal("layerID" in o, false);
  assert.deepEqual(r.bbox, { left: 0, top: 0, right: 1024, bottom: 2000 });
  assert.equal(r.px_sampled, 511 * 998);
  assert.equal(r.clipped_high_pct, 100);
  assert.equal(r.mean.l, 255);
  assert.equal(r.layer, undefined);
  assert.equal(ps.disposed.length, 1);
  assert.deepEqual(ps.calls.find((c) => c[0] === "getData")[1], { chunky: true });
});

test("region_stats on a layer passes layerID and skips targetSize for narrow boxes", async () => {
  const ps = makeStub({ pixel: [0, 0, 0] });
  const r = await region_stats(ps, { bbox: { left: 10, top: 10, right: 110, bottom: 60 }, layer: 33 });
  const o = getPixelsOpts(ps);
  assert.equal(o.layerID, 33);
  assert.equal("targetSize" in o, false);
  assert.equal(r.layer, 33);
  assert.equal(r.px_sampled, 5000);
  assert.equal(r.clipped_low_pct, 100);
});

test("region_stats rejects non-RGB pixel data with UNSUPPORTED_PIXELS and disposes", async () => {
  const ps = makeStub({ components: 1 });
  await assert.rejects(
    region_stats(ps, { bbox: { left: 0, top: 0, right: 10, bottom: 10 } }),
    (e) => e.code === "UNSUPPORTED_PIXELS" && /1/.test(e.message),
  );
  assert.equal(ps.disposed.length, 1);
});

test("open_document opens the file in a modal scope and returns the new document", async () => {
  const docs = [{ id: 5, name: "a.psd", width: 10, height: 10, layers: [] }];
  const ps = makeStub({ docs });
  let active = docs[0];
  Object.defineProperty(ps.app, "activeDocument", { get: () => active, configurable: true });
  ps.fs = { async getEntryWithUrl(url) { ps.calls.push(["getEntryWithUrl", url]); return { url }; } };
  ps.app.open = async (entry) => {
    ps.calls.push(["open", entry.url]);
    const d = { id: 9, name: "new.jpg", width: 20, height: 30, layers: [] };
    docs.push(d); active = d; return d;
  };
  ps.action = { batchPlay: async () => [] };
  const r = await open_document(ps, { path: "/tmp/x/new.jpg" });
  assert.equal(r.id, 9);
  assert.deepEqual(r.open_docs.map((d) => d.id), [5, 9]);
  const names = ps.calls.map((c) => c[0]);
  assert.ok(names.indexOf("executeAsModal") < names.indexOf("open"));
  assert.deepEqual(ps.calls.find((c) => c[0] === "getEntryWithUrl"), ["getEntryWithUrl", "file:/tmp/x/new.jpg"]);
  await assert.rejects(open_document(ps, { path: "relative.jpg" }), (e) => e.code === "INVALID_ARGS");
  assert.equal(ps.calls.filter((c) => c[0] === "open").length, 1);
});

// ---------- A6: bug 9 ----------

test("render_preview never sends an exact integer ratio (2050 into 1025 asks for 1024)", async () => {
  const ps = makeStub({ docs: [{ id: 5, width: 2450, height: 4356 }] });
  const r = await render_preview(ps, { region: { left: 200, top: 450, right: 2250, bottom: 1150 }, max_px: 1025 });
  const o = getPixelsOpts(ps);
  assert.deepEqual(o.sourceBounds, { left: 200, top: 450, right: 2250, bottom: 1150 });
  assert.deepEqual(o.targetSize, { width: 1024 });
  assert.deepEqual(r.region, { left: 200, top: 450, right: 2250, bottom: 1150 });
  assert.equal(r.scale, 2050 / 1024);
  assert.equal(r.warning, undefined);
});

function stubReturning(sourceBounds, level) {
  const ps = makeStub({ docs: [{ id: 5, width: 2450, height: 4356 }] });
  const get = ps.imaging.getPixels;
  ps.imaging.getPixels = async (opts) => ({ ...(await get(opts)), sourceBounds, level });
  return ps;
}

test("render_preview maps with the returned sourceBounds when they differ, and warns", async () => {
  const ps = stubReturning({ left: 94, top: 277, right: 2144, bottom: 977 }, 0);
  const r = await render_preview(ps, { region: { left: 200, top: 450, right: 2250, bottom: 1150 }, max_px: 1025 });
  assert.deepEqual(r.region, { left: 94, top: 277, right: 2144, bottom: 977 });
  assert.equal(r.scale, 2050 / 1024);
  assert.match(r.warning, /returned pixels for \{left 94, top 277, right 2144, bottom 977\}/);
});

test("render_preview: returned bounds that echo the request (or its pyramid level) are not a mismatch", async () => {
  const echo = stubReturning({ left: 200, top: 450, right: 2250, bottom: 1150 }, 0);
  const r = await render_preview(echo, { region: { left: 200, top: 450, right: 2250, bottom: 1150 }, max_px: 1025 });
  assert.equal(r.warning, undefined);
  const lv = stubReturning({ left: 100, top: 225, right: 1125, bottom: 575 }, 1);
  const r2 = await render_preview(lv, { region: { left: 200, top: 450, right: 2250, bottom: 1150 }, max_px: 1025 });
  assert.deepEqual(r2.region, { left: 200, top: 450, right: 2250, bottom: 1150 });
  assert.equal(r2.warning, undefined);
});

test("region_stats reports the returned bbox and a warning on a mismatch", async () => {
  const ps = stubReturning({ left: 500, top: 500, right: 1524, bottom: 1000 }, 0);
  const r = await region_stats(ps, { bbox: { left: 1000, top: 1000, right: 2024, bottom: 1500 } });
  assert.deepEqual(r.bbox, { left: 500, top: 500, right: 1524, bottom: 1000 });
  assert.match(r.warning, /instead of the requested/);
});

test("region_stats on a layer ignores layer-clipped sourceBounds (no reconcile, no warning)", async () => {
  // a layer read reports sourceBounds clipped to the layer's own bounds
  const ps = stubReturning({ left: 1200, top: 1100, right: 1400, bottom: 1300 }, 0);
  const bbox = { left: 1000, top: 1000, right: 2024, bottom: 1500 };
  const r = await region_stats(ps, { bbox, layer: 33 });
  assert.equal(getPixelsOpts(ps).layerID, 33);
  assert.deepEqual(r.bbox, bbox);
  assert.equal(r.warning, undefined);
  assert.equal(r.layer, 33);
});

test("get_document: modal is null normally", async () => {
  const { get_document } = require("../lib/actions/see");
  const ps = makeStub({ docs: [{ id: 5, name: "a.psd", width: 3000, height: 2000, layers: [] }] });
  ps.action = { async batchPlay(descs) { return descs.map(() => ({})); } };
  const r = await get_document(ps, {});
  assert.equal(r.modal, null);
  assert.equal(r.id, 5);
});
