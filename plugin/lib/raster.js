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
  return finishMask(fill, w, h, featherPx, invert);
}

// Float 0..255 coverage -> 8-bit mask: (featherPx > 0) a box blur of radius
// round(featherPx) applied twice, then optional invert. Shared by every mask
// builder so feathering means the same thing everywhere.
function finishMask(fill, w, h, featherPx, invert) {
  const r = featherPx > 0 ? Math.round(featherPx) : 0;
  const src = r > 0 ? boxBlur(boxBlur(fill, w, h, r), w, h, r) : fill;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const v = clampByte(src[i]);
    out[i] = invert ? 255 - v : v;
  }
  return out;
}

// Rec. 709 luminance, the formula region_stats uses.
const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// rgb: chunky 8-bit RGB (w*h*3). 255 where minL <= L <= maxL, else 0.
// L is snapped to 1e-6 first: the weights sum to 1 only up to float error, so
// lumaOf(255,255,255) is 254.99999999999997 and would miss an inclusive 255.
function luminanceMask(rgb, w, h, minL, maxL, featherPx = 0, invert = false) {
  const n = w * h;
  const fill = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = Math.round(lumaOf(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) * 1e6) / 1e6;
    if (l >= minL && l <= maxL) fill[i] = 255;
  }
  return finishMask(fill, w, h, featherPx, invert);
}

// Mean colour of the (2*radius+1)^2 box centred on pixel (floor x, floor y),
// clipped to the canvas; rounded to integers.
function sampleMean(rgb, w, h, x, y, radius = 2) {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let yy = Math.max(0, cy - radius); yy <= Math.min(h - 1, cy + radius); yy++) {
    for (let xx = Math.max(0, cx - radius); xx <= Math.min(w - 1, cx + radius); xx++) {
      const i = (yy * w + xx) * 3;
      r += rgb[i];
      g += rgb[i + 1];
      b += rgb[i + 2];
      n++;
    }
  }
  if (n === 0) throw codedError("OUT_OF_BOUNDS", `Sample point (${x}, ${y}) is outside the ${w}x${h} canvas`);
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

// Distance = max |channel difference| to target. 255 when distance <= fuzz,
// falling linearly to 0 at 2*fuzz (fuzz 0: exact matches only).
function colorMask(rgb, w, h, target, fuzz, featherPx = 0, invert = false) {
  const n = w * h;
  const fill = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dist = Math.max(
      Math.abs(rgb[i * 3] - target.r),
      Math.abs(rgb[i * 3 + 1] - target.g),
      Math.abs(rgb[i * 3 + 2] - target.b),
    );
    if (dist <= fuzz) fill[i] = 255;
    else if (dist < 2 * fuzz) fill[i] = (255 * (2 * fuzz - dist)) / fuzz;
  }
  return finishMask(fill, w, h, featherPx, invert);
}

const clamp01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t);

// spec: {kind: "linear", from, to} | {kind: "radial", from, radius_px}, invert?
// Pixels are sampled at their centres. Linear: 255 at from, 0 at to, linear
// along the from->to vector and clamped beyond both ends. Radial: 255 at
// from, 0 at radius_px, smoothstep in between.
function gradientMask(w, h, spec) {
  const { kind, from, to, radius_px: radius } = spec;
  const out = new Uint8Array(w * h);
  let valueAt;
  if (kind === "linear") {
    if (!to) throw codedError("INVALID_ARGS", "linear gradient needs to");
    const vx = to.x - from.x;
    const vy = to.y - from.y;
    const len2 = vx * vx + vy * vy;
    if (!(len2 > 0)) throw codedError("INVALID_ARGS", "linear gradient needs from and to to differ");
    valueAt = (px, py) => 255 * (1 - clamp01(((px - from.x) * vx + (py - from.y) * vy) / len2));
  } else if (kind === "radial") {
    if (!(radius > 0)) throw codedError("INVALID_ARGS", "radial gradient needs radius_px > 0");
    valueAt = (px, py) => {
      const t = clamp01(Math.hypot(px - from.x, py - from.y) / radius);
      return 255 * (1 - t * t * (3 - 2 * t));
    };
  } else {
    throw codedError("INVALID_ARGS", `kind must be linear or radial, got ${kind}`);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = clampByte(valueAt(x + 0.5, y + 0.5));
      out[y * w + x] = spec.invert ? 255 - v : v;
    }
  }
  return out;
}

// Percentage of mask pixels >= 128, one decimal.
function coveragePct(buf) {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] >= 128) n++;
  return Math.round((1000 * n) / buf.length) / 10;
}

// Mask bytes (one channel) -> chunky RGB with the channel tripled, for JPEG
// encoding (encodeImageData needs RGB).
function grayToRgb(gray) {
  const out = new Uint8Array(gray.length * 3);
  for (let i = 0; i < gray.length; i++) {
    out[i * 3] = gray[i];
    out[i * 3 + 1] = gray[i];
    out[i * 3 + 2] = gray[i];
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

module.exports = {
  rasterizeStrokes, polygonMask, imageDataFromMask, finishMask, lumaOf, luminanceMask,
  sampleMean, colorMask, gradientMask, coveragePct, grayToRgb,
};
