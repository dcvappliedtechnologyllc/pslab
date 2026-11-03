// Pure geometry math for the straighten tool. No Photoshop.
//
// Angle convention (matches Photoshop's Free Transform angle): image y points
// down and a positive angle is a CLOCKWISE rotation on screen. A line "tilted
// +2 degrees from vertical" has its top leaning 2 degrees to the right; the
// rotation that straightens it is -2 degrees (counter-clockwise).

const DEG = 180 / Math.PI;
const BIN = 0.1; // histogram resolution in degrees
const SMOOTH_BINS = 3; // +-0.3 degrees
const MIN_MAGNITUDE = 16; // Sobel magnitude floor on 0..255 luminance (flat or noise-only images)

// Round to `step` (0.1 for applied angles, 0.01 for measurements), no -0.
const roundTo = (x, step) => {
  const r = Math.round(x / step) * step;
  const out = Number(r.toFixed(6));
  return out === 0 ? 0 : out;
};
const round1 = (x) => roundTo(x, 0.1);

// Chunky 8-bit pixels -> Float32Array luminance. components: 1 (gray) or 2
// (gray + alpha) use the gray value; 3 (RGB) or 4 (RGBA) use Rec. 709 weights
// (the alpha channel is ignored).
function toGray(data, w, h, components = 3) {
  const n = w * h;
  const gray = new Float32Array(n);
  if (components < 3) {
    for (let i = 0; i < n; i++) gray[i] = data[i * components];
    return gray;
  }
  for (let i = 0; i < n; i++) {
    const o = i * components;
    gray[i] = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
  }
  return gray;
}

// Sobel gradients for the interior pixels (the 1 px border stays 0).
function sobel(gray, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = gray[i - w - 1];
      const t = gray[i - w];
      const tr = gray[i - w + 1];
      const l = gray[i - 1];
      const r = gray[i + 1];
      const bl = gray[i + w - 1];
      const b = gray[i + w];
      const br = gray[i + w + 1];
      gx[i] = tr + 2 * r + br - tl - 2 * l - bl;
      gy[i] = bl + 2 * b + br - tl - 2 * t - tr;
    }
  }
  return { gx, gy };
}

// Estimate the tilt of the dominant near-vertical (or near-horizontal) edges.
// Returns {angle_deg, confidence, edges_used, edges_total} where angle_deg is
// the rotation to APPLY (positive = clockwise) so those edges line up, and
// confidence is the share of the edge weight within +-0.3 degrees of the peak.
function estimateTilt(gray, w, h, { vertical = true, maxDeviation = 12 } = {}) {
  const none = { angle_deg: 0, confidence: 0, edges_used: 0, edges_total: 0 };
  if (!(w >= 3 && h >= 3)) return none;
  const { gx, gy } = sobel(gray, w, h);
  const n = w * h;
  const mag = new Float32Array(n);
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < n; i++) {
    const m = Math.hypot(gx[i], gy[i]);
    mag[i] = m;
    sum += m;
    sum2 += m * m;
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const threshold = Math.max(mean + 2 * sd, MIN_MAGNITUDE);

  const bins = Math.round((2 * maxDeviation) / BIN) + 1;
  const hist = new Float64Array(bins);
  let edgesTotal = 0;
  let edgesUsed = 0;
  let weightUsed = 0;
  for (let i = 0; i < n; i++) {
    const m = mag[i];
    if (m <= threshold) continue;
    edgesTotal++;
    let a = gx[i];
    let b = gy[i];
    // Clockwise tilt of the edge, in degrees. The gradient is normal to the edge:
    // a near-vertical edge tilted t clockwise has normal (cos t, sin t); a
    // near-horizontal one has normal (-sin t, cos t). Flip the normal to a
    // canonical sign first so both edge polarities agree.
    let dev;
    if (vertical) {
      if (a < 0) {
        a = -a;
        b = -b;
      }
      dev = Math.atan2(b, a) * DEG;
    } else {
      if (b < 0) {
        a = -a;
        b = -b;
      }
      dev = Math.atan2(-a, b) * DEG;
    }
    if (Math.abs(dev) > maxDeviation) continue;
    edgesUsed++;
    weightUsed += m;
    hist[Math.round((dev + maxDeviation) / BIN)] += m;
  }
  if (edgesUsed === 0 || weightUsed === 0) return { ...none, edges_total: edgesTotal };

  // Box-smooth +-0.3 degrees, take the peak, then refine it with the weighted
  // mean of the raw histogram inside the same window.
  let peak = 0;
  let best = -1;
  for (let k = 0; k < bins; k++) {
    let s = 0;
    for (let j = Math.max(0, k - SMOOTH_BINS); j <= Math.min(bins - 1, k + SMOOTH_BINS); j++) s += hist[j];
    if (s > best) {
      best = s;
      peak = k;
    }
  }
  let wsum = 0;
  let asum = 0;
  for (let j = Math.max(0, peak - SMOOTH_BINS); j <= Math.min(bins - 1, peak + SMOOTH_BINS); j++) {
    wsum += hist[j];
    asum += hist[j] * (j * BIN - maxDeviation);
  }
  const tilt = wsum > 0 ? asum / wsum : peak * BIN - maxDeviation;
  return {
    angle_deg: roundTo(-tilt, 0.01),
    confidence: Math.round((best / weightUsed) * 1000) / 1000,
    edges_used: edgesUsed,
    edges_total: edgesTotal,
  };
}

module.exports = { estimateTilt, toGray, sobel, round1 };
