// Read-only actions.
const { docSummary, resolveDoc } = require("../doc");
const { runRead } = require("../step");
const { regionStats, clampBbox } = require("../stats");

async function get_document(ps, args = {}) {
  const { d, docs } = resolveDoc(ps, args.doc);
  return {
    ...(await docSummary(ps, d)),
    open_docs: docs.map((x) => ({ id: x.id, name: x.name })),
  };
}

function unsupported(message) {
  const e = new Error(message);
  e.code = "UNSUPPORTED_PIXELS";
  return e;
}

// Composite (or one layer) pixels for a clamped box; caller disposes imageData.
async function readPixels(ps, d, box, targetSize, layer) {
  const opts = { documentID: d.id, sourceBounds: box, componentSize: 8, applyAlpha: true };
  if (layer !== undefined && layer !== null) opts.layerID = layer;
  if (targetSize) opts.targetSize = targetSize;
  const { imageData } = await ps.imaging.getPixels(opts);
  return imageData;
}

async function render_preview(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  const maxPx = args.max_px ?? 1500;
  const w = Number(d.width);
  const h = Number(d.height);
  const region = clampBbox(args.region ?? { left: 0, top: 0, right: w, bottom: h }, w, h);
  const rw = region.right - region.left;
  const rh = region.bottom - region.top;
  let targetSize = null;
  if (Math.max(rw, rh) > maxPx) targetSize = rw >= rh ? { width: maxPx } : { height: maxPx };
  return runRead(ps, "Render Preview", async () => {
    const imageData = await readPixels(ps, d, region, targetSize);
    try {
      const jpeg_base64 = await ps.imaging.encodeImageData({ imageData, base64: true });
      return {
        jpeg_base64,
        preview: { w: imageData.width, h: imageData.height },
        region,
        scale: rw / imageData.width,
      };
    } finally {
      imageData.dispose();
    }
  });
}

async function region_stats(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  const bbox = clampBbox(args.bbox, Number(d.width), Number(d.height));
  const bw = bbox.right - bbox.left;
  const targetSize = bw > 512 ? { width: 512 } : null;
  const layer = args.layer ?? undefined;
  return runRead(ps, "Region Stats", async () => {
    const imageData = await readPixels(ps, d, bbox, targetSize, layer);
    try {
      if (imageData.components !== 3) {
        throw unsupported(`Expected 3 RGB components, got ${imageData.components}`);
      }
      const data = await imageData.getData({ chunky: true });
      const stats = regionStats(data, imageData.width, imageData.height);
      const out = { ...stats, bbox };
      if (layer !== undefined) out.layer = layer;
      return out;
    } finally {
      imageData.dispose();
    }
  });
}

function invalidArgs(message) {
  const e = new Error(message);
  e.code = "INVALID_ARGS";
  return e;
}

// Open a file from disk as a new document and return its summary. Runs in a
// modal scope (app.open requires one) but creates no history state of ours.
async function open_document(ps, args = {}) {
  const path = args.path;
  if (typeof path !== "string" || !path.startsWith("/")) throw invalidArgs("path must be an absolute file path");
  let entry;
  try {
    entry = await ps.fs.getEntryWithUrl("file:" + path);
  } catch (e) {
    const err = new Error(`cannot read ${path}: ${String((e && e.message) || e)}`);
    err.code = "FILE_NOT_FOUND";
    throw err;
  }
  await runRead(ps, "Open document", async () => {
    await ps.app.open(entry);
  });
  const { d, docs } = resolveDoc(ps);
  return {
    ...(await docSummary(ps, d)),
    open_docs: docs.map((x) => ({ id: x.id, name: x.name })),
  };
}

module.exports = { get_document, open_document, render_preview, region_stats };
