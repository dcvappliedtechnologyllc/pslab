// Pure image tiling on chunky 8-bit RGB buffers (3 bytes per pixel, rows top
// to bottom). No Photoshop requires: tested under Node.

// Chunky 8-bit data with 1, 3 or 4 components as RGB (alpha dropped, gray
// repeated). getPixels with applyAlpha still reports 4 components on a
// document with transparency.
function toRgb(data, components, count) {
  if (components === 3) return data.length === count * 3 ? data : data.subarray(0, count * 3);
  const out = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = i * components;
    if (components === 1) {
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = data[o];
    } else {
      out[i * 3] = data[o];
      out[i * 3 + 1] = data[o + 1];
      out[i * 3 + 2] = data[o + 2];
    }
  }
  return out;
}

// Copy an RGB image into dst (dstWidth wide) with its top-left at (x, y),
// keeping at most w x h of it (its top-left part).
function blit(dst, dstWidth, img, x, y, w = img.width, h = img.height) {
  const row = img.width * 3;
  const keep = Math.min(w, img.width) * 3;
  for (let r = 0; r < Math.min(h, img.height); r++) {
    const from = r * row;
    dst.set(img.data.subarray(from, from + keep), ((y + r) * dstWidth + x) * 3);
  }
}

function filled(width, height, bg) {
  const data = new Uint8Array(width * height * 3);
  data.fill(bg);
  return data;
}

// a on the left, b on the right, gapPx of grey (bg) between them. Both images
// must be the same height.
function stitchSideBySide(a, b, gapPx = 8, bg = 128) {
  if (a.height !== b.height) throw new Error(`stitchSideBySide needs equal heights, got ${a.height} and ${b.height}`);
  const width = a.width + gapPx + b.width;
  const height = a.height;
  const data = filled(width, height, bg);
  blit(data, width, a, 0, 0);
  blit(data, width, b, a.width + gapPx, 0);
  return { data, width, height };
}

// Images in a grid of square cells (cell px) left to right, top to bottom,
// cols per row, gap px between cells and around the edge, on a bg grey. Each
// image is centered in its cell (letterboxed); an image larger than the cell
// is cut to it. placements[i] is where image i landed.
function tileGrid(cells, { cols, cell, gap = 8, bg = 128 }) {
  if (!Number.isInteger(cols) || cols < 1) throw new Error("tileGrid needs cols >= 1");
  const rows = Math.max(1, Math.ceil(cells.length / cols));
  const width = cols * cell + gap * (cols + 1);
  const height = rows * cell + gap * (rows + 1);
  const data = filled(width, height, bg);
  const placements = cells.map((img, i) => {
    const w = Math.min(img.width, cell);
    const h = Math.min(img.height, cell);
    const x = gap + (i % cols) * (cell + gap) + Math.floor((cell - w) / 2);
    const y = gap + Math.floor(i / cols) * (cell + gap) + Math.floor((cell - h) / 2);
    blit(data, width, img, x, y, w, h);
    return { x, y, w, h };
  });
  return { data, width, height, placements };
}

module.exports = { toRgb, stitchSideBySide, tileGrid };
