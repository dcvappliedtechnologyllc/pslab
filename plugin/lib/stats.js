// Pure pixel statistics and bbox math. No Photoshop.

const round1 = (x) => Math.round(x * 10) / 10;

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Clamp a {left,top,right,bottom} box to a w x h canvas, rounding to integers.
function clampBbox(bbox, w, h) {
  const left = Math.max(0, Math.round(bbox.left));
  const top = Math.max(0, Math.round(bbox.top));
  const right = Math.min(w, Math.round(bbox.right));
  const bottom = Math.min(h, Math.round(bbox.bottom));
  if (!(left < right && top < bottom)) {
    throw codedError(
      "EMPTY_REGION",
      `Region ${JSON.stringify(bbox)} is empty after clamping to the ${w}x${h} canvas`,
    );
  }
  return { left, top, right, bottom };
}

// rgb: chunky 8-bit RGB, length w*h*3.
function regionStats(rgb, w, h) {
  const n = w * h;
  const histogram_l = new Array(32).fill(0);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sl = 0;
  let high = 0;
  let low = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sr += r;
    sg += g;
    sb += b;
    sl += l;
    histogram_l[Math.min(31, Math.floor(l / 8))]++;
    if (l >= 250) high++;
    if (l <= 5) low++;
  }
  const d = n || 1;
  return {
    mean: { r: round1(sr / d), g: round1(sg / d), b: round1(sb / d), l: round1(sl / d) },
    histogram_l,
    clipped_high_pct: round1((100 * high) / d),
    clipped_low_pct: round1((100 * low) / d),
    px_sampled: n,
  };
}

module.exports = { regionStats, clampBbox };
