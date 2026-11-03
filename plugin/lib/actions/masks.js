// Mask builders computed from pixels: each mutating call is one named history
// state (stepIn); arguments are validated before any modal scope opens.
const { resolveDoc, hasUserMaskStrict } = require("../doc");
const { runRead } = require("../step");
const { readPixels } = require("./see");
const { codedError, requireLayer, stepIn, toBytes, writeMask } = require("./edit");
const { luminanceMask, gradientMask, colorMask, sampleMean, coveragePct, grayToRgb } = require("../raster");

const invalid = (message) => codedError("INVALID_ARGS", message);

// Test hook: the composite is read in bands of <= BAND_ROWS rows when w*h*3
// exceeds this many bytes.
const DEFAULT_BAND_LIMIT = 100 * 1024 * 1024;
const BAND_ROWS = 1024;
let bandLimit = DEFAULT_BAND_LIMIT;
function setBandLimit(bytes) {
  bandLimit = bytes === null || bytes === undefined ? DEFAULT_BAND_LIMIT : bytes;
}

// Full-resolution composite as chunky 8-bit RGB (w*h*3). Must run inside a
// modal scope. Every imageData is disposed.
async function readComposite(ps, d, w, h) {
  const out = new Uint8Array(w * h * 3);
  const rows = w * h * 3 > bandLimit ? BAND_ROWS : h;
  for (let top = 0; top < h; top += rows) {
    const bottom = Math.min(h, top + rows);
    const imageData = await readPixels(ps, d, { left: 0, top, right: w, bottom });
    try {
      if (imageData.components !== 3) {
        throw codedError("UNSUPPORTED_PIXELS", `Expected 3 RGB components, got ${imageData.components}`);
      }
      if (imageData.width !== w || imageData.height !== bottom - top) {
        throw codedError(
          "PIXELS_SIZE",
          `Composite rows ${top}..${bottom} came back ${imageData.width}x${imageData.height}, expected ${w}x${bottom - top}`,
        );
      }
      const data = await imageData.getData({ chunky: true });
      out.set(data.subarray ? data.subarray(0, w * (bottom - top) * 3) : data, top * w * 3);
    } finally {
      imageData.dispose();
    }
  }
  return out;
}

const isInt255 = (v) => Number.isInteger(v) && v >= 0 && v <= 255;

function featherOf(args) {
  const f = args.feather_px ?? 0;
  if (typeof f !== "number" || !(f >= 0)) throw invalid(`feather_px must be >= 0, got ${f}`);
  return f;
}

// Resolve the document and layer and its size; throws before any modal.
function target(ps, args) {
  const { d } = resolveDoc(ps, args.doc);
  requireLayer(d, args.layer);
  return { d, w: Number(d.width), h: Number(d.height) };
}

// ---------- mask_from_luminance ----------

async function mask_from_luminance(ps, args = {}) {
  const minL = args.min_l;
  const maxL = args.max_l ?? 255;
  if (!isInt255(minL)) throw invalid(`min_l must be an integer 0..255, got ${minL}`);
  if (!isInt255(maxL)) throw invalid(`max_l must be an integer 0..255, got ${maxL}`);
  if (minL > maxL) throw invalid(`min_l (${minL}) must not exceed max_l (${maxL})`);
  const feather = featherOf(args);
  const { d, w, h } = target(ps, args);
  return stepIn(ps, `Claude: mask_from_luminance, L ${minL}..${maxL}`, d, async () => {
    const rgb = await readComposite(ps, d, w, h);
    const buf = luminanceMask(rgb, w, h, minL, maxL, feather, !!args.invert);
    await writeMask(ps, d, args.layer, buf, w, h);
    return { ok: true, coverage_pct: coveragePct(buf) };
  });
}

// ---------- mask_gradient ----------

const isPoint = (p) => p !== null && typeof p === "object" && Number.isFinite(p.x) && Number.isFinite(p.y);

async function mask_gradient(ps, args = {}) {
  const { kind, from, to } = args;
  if (kind !== "linear" && kind !== "radial") throw invalid(`kind must be linear or radial, got ${kind}`);
  if (!isPoint(from)) throw invalid("from must be {x, y}");
  if (kind === "linear" && !isPoint(to)) throw invalid("a linear gradient needs to: {x, y}");
  if (kind === "radial" && !(Number.isFinite(args.radius_px) && args.radius_px > 0)) {
    throw invalid(`a radial gradient needs radius_px > 0, got ${args.radius_px}`);
  }
  const { d, w, h } = target(ps, args);
  const buf = gradientMask(w, h, { kind, from, to, radius_px: args.radius_px, invert: !!args.invert });
  return stepIn(ps, `Claude: mask_gradient, ${kind}`, d, async () => {
    await writeMask(ps, d, args.layer, buf, w, h);
    return { ok: true };
  });
}

// ---------- mask_from_color ----------

// Mean of the 5x5 box around a point (clipped to the canvas); modal scope.
async function sampleAt(ps, d, w, h, p) {
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const box = { left: Math.max(0, cx - 2), top: Math.max(0, cy - 2), right: Math.min(w, cx + 3), bottom: Math.min(h, cy + 3) };
  const bw = box.right - box.left;
  const bh = box.bottom - box.top;
  const imageData = await readPixels(ps, d, box);
  try {
    if (imageData.components !== 3) {
      throw codedError("UNSUPPORTED_PIXELS", `Expected 3 RGB components, got ${imageData.components}`);
    }
    const data = await imageData.getData({ chunky: true });
    return sampleMean(data, bw, bh, cx - box.left, cy - box.top);
  } finally {
    imageData.dispose();
  }
}

const isRgb = (c) => c !== null && typeof c === "object" && isInt255(c.r) && isInt255(c.g) && isInt255(c.b);

async function mask_from_color(ps, args = {}) {
  const hasSample = args.sample !== undefined && args.sample !== null;
  const hasRgb = args.rgb !== undefined && args.rgb !== null;
  if (hasSample === hasRgb) throw invalid("pass exactly one of sample {x, y} or rgb {r, g, b}");
  if (hasSample && !isPoint(args.sample)) throw invalid("sample must be {x, y}");
  if (hasRgb && !isRgb(args.rgb)) throw invalid("rgb must be {r, g, b} with integers 0..255");
  const fuzz = args.fuzziness ?? 40;
  if (typeof fuzz !== "number" || !(fuzz >= 0 && fuzz <= 255)) throw invalid(`fuzziness must be 0..255, got ${fuzz}`);
  const feather = featherOf(args);
  const { d, w, h } = target(ps, args);
  if (hasSample) {
    const { x, y } = args.sample;
    if (!(x >= 0 && x < w && y >= 0 && y < h)) {
      throw codedError("OUT_OF_BOUNDS", `sample (${x}, ${y}) is outside the ${w}x${h} canvas`);
    }
  }
  // The history name carries the colour, which a sample only yields once
  // pixels are read: read the 5x5 box in a modal of its own first (no history).
  let color = args.rgb;
  if (hasSample) color = await runRead(ps, "Sample colour", () => sampleAt(ps, d, w, h, args.sample));
  const name = `Claude: mask_from_color, rgb(${color.r},${color.g},${color.b}) ±${fuzz}`;
  return stepIn(ps, name, d, async () => {
    const rgb = await readComposite(ps, d, w, h);
    const buf = colorMask(rgb, w, h, color, fuzz, feather, !!args.invert);
    await writeMask(ps, d, args.layer, buf, w, h);
    return { ok: true, coverage_pct: coveragePct(buf), sampled_rgb: { r: color.r, g: color.g, b: color.b } };
  });
}

// ---------- preview_mask ----------

// Read-only: the layer's user mask as a downscaled JPEG (white = revealed).
async function preview_mask(ps, args = {}) {
  const maxPx = args.max_px ?? 1000;
  if (!(Number.isInteger(maxPx) && maxPx >= 200 && maxPx <= 4000)) throw invalid(`max_px must be an integer 200..4000, got ${maxPx}`);
  const { d, w, h } = target(ps, args);
  let targetSize = null;
  if (Math.max(w, h) > maxPx) targetSize = w >= h ? { width: maxPx } : { height: maxPx };
  return runRead(ps, "Preview Mask", async () => {
    if (!(await hasUserMaskStrict(ps, d.id, args.layer))) return { has_mask: false };
    const opts = {
      documentID: d.id,
      layerID: args.layer,
      kind: "user",
      sourceBounds: { left: 0, top: 0, right: w, bottom: h },
    };
    if (targetSize) opts.targetSize = targetSize;
    const { imageData: mask } = await ps.imaging.getLayerMask(opts);
    let rgbImage = null;
    try {
      const pw = mask.width;
      const ph = mask.height;
      const data = await mask.getData({ chunky: true });
      if (data.length !== pw * ph) {
        throw codedError("MASK_SIZE", `Mask preview is ${data.length} values, expected ${pw * ph} (${pw}x${ph})`);
      }
      // encodeImageData needs RGB: triple the single mask channel.
      rgbImage = await ps.imaging.createImageDataFromBuffer(grayToRgb(toBytes(data)), {
        width: pw,
        height: ph,
        components: 3,
        colorSpace: "RGB",
        chunky: true,
      });
      const jpeg_base64 = await ps.imaging.encodeImageData({ imageData: rgbImage, base64: true });
      return { has_mask: true, jpeg_base64, preview: { w: pw, h: ph }, scale: w / pw };
    } finally {
      mask.dispose();
      if (rgbImage) rgbImage.dispose();
    }
  });
}

module.exports = { mask_from_luminance, mask_gradient, mask_from_color, preview_mask, readComposite, setBandLimit };
