// Pure request math for downscaled getPixels reads. No Photoshop.
//
// Bug 9: a region read whose long edge is an exact integer multiple of the
// target size (2050 px into 1025) came back offset, roughly the requested
// origin halved, as if Photoshop served the read from a pyramid level and
// mapped sourceBounds twice. Non-integer ratios were correct, so every
// downscaled read asks for one pixel less when the ratio would be exact.

// The largest target <= cap that does not divide `long` exactly; null when
// `long` fits in cap (no downscale).
function safeTarget(long, cap) {
  if (!(long > cap)) return null;
  let t = cap;
  while (t > 1 && long % t === 0) t -= 1;
  return t;
}

// region {left, top, right, bottom} -> {sourceBounds, targetSize} for getPixels.
// targetSize is on the long side, or null when the long edge fits in maxPx.
function previewRequest(region, maxPx) {
  const rw = region.right - region.left;
  const rh = region.bottom - region.top;
  const wide = rw >= rh;
  const t = safeTarget(wide ? rw : rh, maxPx);
  const sourceBounds = { left: region.left, top: region.top, right: region.right, bottom: region.bottom };
  if (t === null) return { sourceBounds, targetSize: null };
  return { sourceBounds, targetSize: wide ? { width: t } : { height: t } };
}

// Width-capped reads (region_stats 512, patchMean 256): the target width, or null.
function safeTargetWidth(width, cap) {
  return safeTarget(width, cap);
}

const edge = (v) => Number(v !== null && typeof v === "object" ? ("_value" in v ? v._value : v.value) : v);
const KEYS = ["left", "top", "right", "bottom"];

function close(a, b, tol) {
  return KEYS.every((k) => Math.abs(a[k] - b[k]) <= tol);
}

// Compare the sourceBounds getPixels says it returned with the request.
// Within 1 px (or matching once scaled up from pyramid `level` coordinates)
// the request stands; otherwise the returned bounds describe the pixels and
// mismatch is true so the caller can warn.
function reconcileBounds(requested, returned, level) {
  if (!returned) return { region: requested, mismatch: false };
  const got = {};
  for (const k of KEYS) got[k] = edge(returned[k]);
  if (!KEYS.every((k) => Number.isFinite(got[k]))) return { region: requested, mismatch: false };
  if (close(got, requested, 1)) return { region: requested, mismatch: false };
  const lv = Number(level);
  if (Number.isInteger(lv) && lv > 0) {
    const f = 2 ** lv;
    const up = {};
    for (const k of KEYS) up[k] = got[k] * f;
    if (close(up, requested, f)) return { region: requested, mismatch: false };
  }
  return { region: got, mismatch: true };
}

module.exports = { previewRequest, safeTargetWidth, reconcileBounds };
