// Pure mask rasterizer: strokes and polygons -> 8-bit grayscale mask buffers.
// No Photoshop requires; imageDataFromMask takes `ps` as a parameter.
//
// Buffers are Uint8Array(w*h), row-major, 0 = black, 255 = white.
// Coordinates are image pixels (floats allowed). Pixel (x, y) is sampled at
// its center (x + 0.5, y + 0.5), for both strokes and polygons.

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const clampByte = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

// Max-accumulate one round dab into `cov`, touching only its clipped bbox.
// Returns false when the dab misses the canvas entirely.
function stamp(cov, w, h, cx, cy, radius, inner, box) {
  const x0 = Math.max(0, Math.floor(cx - radius - 0.5));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius - 0.5));
  const y0 = Math.max(0, Math.floor(cy - radius - 0.5));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius - 0.5));
  if (x0 > x1 || y0 > y1) return false;
  const ramp = radius - inner;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const d = Math.sqrt(dx * dx + dy * dy);
      let v;
      if (d <= inner) v = 1;
      else if (d >= radius) continue;
      else v = (radius - d) / ramp;
      if (v > cov[row + x]) cov[row + x] = v;
    }
  }
  if (x0 < box.x0) box.x0 = x0;
  if (x1 > box.x1) box.x1 = x1;
  if (y0 < box.y0) box.y0 = y0;
  if (y1 > box.y1) box.y1 = y1;
  return true;
}

// strokes: [{points:[{x,y}], size_px, hardness 0..1, opacity 0..1}]
// Each stroke is a polyline stamped every size_px/8 px (plus endpoints);
// coverage is the max over its stamps; strokes composite in order onto the
// running result: out = base + (target - base) * coverage * opacity.
function rasterizeStrokes(w, h, strokes, color, base) {
  const out = base ? Uint8Array.from(base) : new Uint8Array(w * h).fill(255);
  const target = color === "black" ? 0 : 255;
  const cov = new Float32Array(w * h);
  for (const s of strokes) {
    // Non-finite points are dropped; a stroke without a finite positive size
    // is skipped; hardness defaults to 0 and opacity to 1 when not finite.
    const pts = (Array.isArray(s.points) ? s.points : []).filter(
      (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y),
    );
    if (pts.length === 0) continue;
    if (!Number.isFinite(s.size_px) || !(s.size_px > 0)) continue;
    const radius = s.size_px / 2;
    const hardness = Number.isFinite(s.hardness) ? s.hardness : 0;
    const opacity = Math.max(0, Math.min(1, Number.isFinite(s.opacity) ? s.opacity : 1));
    const inner = Math.max(0, Math.min(1, hardness)) * radius;
    const spacing = Math.max(s.size_px / 8, 0.25);
    const box = { x0: w, x1: -1, y0: h, y1: -1 };
    stamp(cov, w, h, pts[0].x, pts[0].y, radius, inner, box);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(len / spacing));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        stamp(cov, w, h, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, radius, inner, box);
      }
    }
    // Composite and clear coverage over the touched bbox only.
    for (let y = box.y0; y <= box.y1; y++) {
      const row = y * w;
      for (let x = box.x0; x <= box.x1; x++) {
        const c = cov[row + x];
        if (c === 0) continue;
        const b = out[row + x];
        out[row + x] = clampByte(b + (target - b) * c * opacity);
        cov[row + x] = 0;
      }
    }
  }
  return out;
}

// One separable box-blur pass (horizontal then vertical), edge-clamped.
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * norm;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return dst;
}

// Even-odd scanline fill sampled at pixel centers, then (featherPx > 0) a
// box blur of radius round(featherPx) applied twice, then optional invert.
function polygonMask(w, h, points, featherPx, invert) {
  if (!Array.isArray(points) || points.length < 3) {
    throw codedError("INVALID_POLYGON", "A polygon needs at least 3 points");
  }
  const fill = new Float32Array(w * h);
  const n = points.length;
  const xs = [];
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if (a.y <= yc !== b.y <= yc) xs.push(a.x + ((yc - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      // Pixels whose center x + 0.5 lies in [xs[i], xs[i+1]).
      const from = Math.max(0, Math.ceil(xs[i] - 0.5));
      const to = Math.min(w - 1, Math.ceil(xs[i + 1] - 0.5) - 1);
      for (let x = from; x <= to; x++) fill[y * w + x] = 255;
    }
  }
  const r = featherPx > 0 ? Math.round(featherPx) : 0;
  const src = r > 0 ? boxBlur(boxBlur(fill, w, h, r), w, h, r) : fill;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const v = clampByte(src[i]);
    out[i] = invert ? 255 - v : v;
  }
  return out;
}

function imageDataFromMask(ps, buf, w, h) {
  return ps.imaging.createImageDataFromBuffer(buf, {
    width: w,
    height: h,
    components: 1,
    colorSpace: "Grayscale",
    colorProfile: "Gray Gamma 2.2",
    chunky: true,
  });
}

module.exports = { rasterizeStrokes, polygonMask, imageDataFromMask };
