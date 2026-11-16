// Read-only actions.
const { docSummary, resolveDoc, modalState } = require("../doc");
const { modalHint } = require("./dev");
const { runRead } = require("../step");
const { regionStats, clampBbox } = require("../stats");
const { previewRequest, safeTargetWidth, reconcileBounds } = require("../preview");

async function get_document(ps, args = {}) {
  const { d, docs } = resolveDoc(ps, args.doc);
  // Probed before the tree is read: during a crop the tree shows "Crop Preview".
  const modal = await modalState(ps, d, modalHint());
  return {
    ...(await docSummary(ps, d, { detail: true })),
    modal,
    open_docs: docs.map((x) => ({ id: x.id, name: x.name })),
  };
}

function unsupported(message) {
  const e = new Error(message);
  e.code = "UNSUPPORTED_PIXELS";
  return e;
}

// Composite (or one layer) pixels for a clamped box, with the sourceBounds
// and pyramid level getPixels reports; caller disposes imageData.
async function readRegion(ps, d, box, targetSize, layer) {
  const opts = { documentID: d.id, sourceBounds: box, componentSize: 8, applyAlpha: true };
  if (layer !== undefined && layer !== null) opts.layerID = layer;
  if (targetSize) opts.targetSize = targetSize;
  const { imageData, sourceBounds, level } = await ps.imaging.getPixels(opts);
  return { imageData, sourceBounds, level };
}

async function readPixels(ps, d, box, targetSize, layer) {
  return (await readRegion(ps, d, box, targetSize, layer)).imageData;
}

const boxText = (b) => `{left ${b.left}, top ${b.top}, right ${b.right}, bottom ${b.bottom}}`;

function mismatchWarning(requested, got, level) {
  return `Photoshop returned pixels for ${boxText(got)} instead of the requested ${boxText(requested)}` +
    `${level !== undefined ? ` (level ${level})` : ""}; region and scale describe what was returned`;
}

async function render_preview(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  const maxPx = args.max_px ?? 1500;
  const w = Number(d.width);
  const h = Number(d.height);
  const region = clampBbox(args.region ?? { left: 0, top: 0, right: w, bottom: h }, w, h);
  // never an exact integer downscale ratio (bug 9: those reads came back offset)
  const req = previewRequest(region, maxPx);
  return runRead(ps, "Render Preview", async () => {
    const got = await readRegion(ps, d, req.sourceBounds, req.targetSize);
    const imageData = got.imageData;
    try {
      const { region: used, mismatch } = reconcileBounds(region, got.sourceBounds, got.level);
      const jpeg_base64 = await ps.imaging.encodeImageData({ imageData, base64: true });
      const out = {
        jpeg_base64,
        preview: { w: imageData.width, h: imageData.height },
        region: used,
        scale: (used.right - used.left) / imageData.width,
      };
      if (mismatch) out.warning = mismatchWarning(region, used, got.level);
      return out;
    } finally {
      imageData.dispose();
    }
  });
}

async function region_stats(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  const bbox = clampBbox(args.bbox, Number(d.width), Number(d.height));
  const tw = safeTargetWidth(bbox.right - bbox.left, 512);
  const targetSize = tw === null ? null : { width: tw };
  const layer = args.layer ?? undefined;
  return runRead(ps, "Region Stats", async () => {
    const got = await readRegion(ps, d, bbox, targetSize, layer);
    const imageData = got.imageData;
    try {
      if (imageData.components !== 3) {
        throw unsupported(`Expected 3 RGB components, got ${imageData.components}`);
      }
      const data = await imageData.getData({ chunky: true });
      const stats = regionStats(data, imageData.width, imageData.height);
      const { region: used, mismatch } = reconcileBounds(bbox, got.sourceBounds, got.level);
      const out = { ...stats, bbox: used };
      if (layer !== undefined) out.layer = layer;
      if (mismatch) out.warning = mismatchWarning(bbox, used, got.level);
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

// Open one file entry as a new document and return the new (now active)
// document's {id, name}. Call inside a modal scope: app.open requires one.
async function openEntry(ps, entry) {
  await ps.app.open(entry);
  const d = ps.app.activeDocument;
  return { id: d.id, name: String(d.name ?? d.title ?? "") };
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
  await runRead(ps, "Open document", () => openEntry(ps, entry));
  const { d, docs } = resolveDoc(ps);
  return {
    ...(await docSummary(ps, d)),
    open_docs: docs.map((x) => ({ id: x.id, name: x.name })),
  };
}

module.exports = { get_document, open_document, render_preview, region_stats, openEntry, readPixels, readRegion };
