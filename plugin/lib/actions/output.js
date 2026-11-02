// Output actions: crop (one undoable history state), export and save (files on
// disk; no history state). Validation happens before any modal scope opens.
const { runStep, runRead } = require("../step");
const { bitsOf, resolveDoc } = require("../doc");

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const invalid = (message) => codedError("INVALID_ARGS", message);
const isInt = (v) => Number.isInteger(v);

function splitPath(p) {
  const i = p.lastIndexOf("/");
  return { dir: p.slice(0, i) || "/", base: p.slice(i + 1) };
}

function requireFilePath(p, exts) {
  if (typeof p !== "string" || !p.startsWith("/")) throw invalid(`path must be absolute, got ${p}`);
  const { base } = splitPath(p);
  if (!base || !exts.some((ext) => base.toLowerCase().endsWith(ext))) {
    throw invalid(`path must end in ${exts.join(" or ")}, got ${p}`);
  }
}

// Returns the folder entry for dir, creating it (and up to `levels` missing
// ancestors) when it does not exist.
async function ensureFolder(fs, dir, levels = 3) {
  try {
    return await fs.getEntryWithUrl("file:" + dir);
  } catch {}
  const { dir: parentDir, base } = splitPath(dir);
  if (levels <= 0 || !base) throw codedError("EXPORT_DIR", `Could not find or create the folder ${dir}`);
  const parent = await ensureFolder(fs, parentDir, levels - 1);
  try {
    return await parent.createFolder(base);
  } catch (e) {
    throw codedError("EXPORT_DIR", `Could not create the folder ${dir}: ${(e && e.message) || e}`);
  }
}

async function fileEntry(ps, p) {
  const { dir, base } = splitPath(p);
  const parent = await ensureFolder(ps.fs, dir);
  return parent.createFile(base, { overwrite: true });
}

// ---------- crop ----------

function ratioBox(w, h, ratio) {
  const m = /^(\d+):(\d+)$/.exec(String(ratio));
  const rw = m ? Number(m[1]) : 0;
  const rh = m ? Number(m[2]) : 0;
  if (!(rw > 0 && rh > 0)) throw invalid(`ratio must look like 4:5, got ${ratio}`);
  let cw;
  let ch;
  if (w * rh >= h * rw) {
    ch = h;
    cw = Math.floor((h * rw) / rh);
  } else {
    cw = w;
    ch = Math.floor((w * rh) / rw);
  }
  if (cw < 1 || ch < 1) throw invalid(`ratio ${ratio} is too extreme for a ${w}x${h} document`);
  const left = Math.floor((w - cw) / 2);
  const top = Math.floor((h - ch) / 2);
  return { left, top, right: left + cw, bottom: top + ch };
}

function checkBox(b, w, h) {
  const ok =
    b && ["left", "top", "right", "bottom"].every((k) => typeof b[k] === "number" && Number.isFinite(b[k])) &&
    b.left >= 0 && b.top >= 0 && b.right <= w && b.bottom <= h && b.left < b.right && b.top < b.bottom;
  if (!ok) throw invalid(`bbox must be {left, top, right, bottom} inside the ${w}x${h} document with left < right and top < bottom`);
  return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
}

async function crop(ps, args = {}) {
  const hasRatio = args.ratio !== undefined && args.ratio !== null;
  const hasBox = args.bbox !== undefined && args.bbox !== null;
  if (hasRatio === hasBox) throw invalid("crop needs exactly one of ratio or bbox");
  const { d } = resolveDoc(ps, args.doc);
  const w = Number(d.width);
  const h = Number(d.height);
  const bbox = hasRatio ? ratioBox(w, h, args.ratio) : checkBox(args.bbox, w, h);
  return runStep(ps, `Claude: crop ${hasRatio ? args.ratio : "bbox"}`, d.id, async () => {
    await d.crop(bbox);
    return { bbox };
  });
}

// ---------- export ----------

function fitLongEdge(w, h, longEdge) {
  const long = Math.max(w, h);
  if (long <= longEdge) return null;
  const scale = longEdge / long;
  return w >= h ? [longEdge, Math.max(1, Math.round(h * scale))] : [Math.max(1, Math.round(w * scale)), longEdge];
}

async function exportJpg(ps, args = {}) {
  const { path, long_edge_px: longEdge, quality } = args;
  requireFilePath(path, [".jpg"]);
  if (!isInt(longEdge) || longEdge < 1) throw invalid(`long_edge_px must be a positive whole number, got ${longEdge}`);
  if (!isInt(quality) || quality < 1 || quality > 12) throw invalid(`quality must be a whole number 1..12, got ${quality}`);
  const { d } = resolveDoc(ps, args.doc);
  return runRead(ps, `Claude: export ${splitPath(path).base}`, async () => {
    // duplicate() makes the copy active and closing it lets Photoshop pick the
    // next tab, so the active document is put back afterwards on every path.
    const original = ps.app.activeDocument;
    try {
      return await exportCopy(ps, d, path, longEdge, quality);
    } finally {
      restoreActive(ps, original);
    }
  });
}

function layerCount(doc) {
  try {
    return Array.from(doc.layers || []).length;
  } catch {
    return null;
  }
}

// The copy is always closed; if closing fails after another error, the first error wins.
// It is merged before the profile conversion, so adjustment layers and blend
// modes are rendered in the document's own profile, not recomputed in sRGB.
// duplicate(name, true) merges while copying; when that leaves more than one
// layer, the copy (never the original) is flattened.
async function exportCopy(ps, d, path, longEdge, quality) {
  const copy = await d.duplicate("pslab export", true);
  let result;
  try {
    if (layerCount(copy) !== 1) await copy.flatten();
    await copy.convertProfile("sRGB IEC61966-2.1", ps.constants.Intent.RELATIVECOLORIMETRIC);
    if (bitsOf(copy.bitsPerChannel) !== 8) {
      try {
        copy.bitsPerChannel = ps.constants.BitsPerChannelType.BIT8;
      } catch (e) {
        throw codedError("EXPORT_FAILED", `Could not convert the copy to 8 bits per channel: ${(e && e.message) || e}`);
      }
    }
    const size = fitLongEdge(Number(copy.width), Number(copy.height), longEdge);
    if (size) await copy.resizeImage(size[0], size[1], undefined, ps.constants.ResampleMethod.BICUBICSHARPER);
    const file = await fileEntry(ps, path);
    await copy.saveAs.jpg(file, { quality, embedColorProfile: true }, true);
    result = { path, width: Number(copy.width), height: Number(copy.height) };
  } catch (e) {
    try {
      await copy.closeWithoutSaving();
    } catch {}
    throw e;
  }
  await copy.closeWithoutSaving();
  return result;
}

function restoreActive(ps, original) {
  try {
    if (!original) return;
    const stillOpen = Array.from(ps.app.documents || []).some((x) => x.id === original.id);
    const active = ps.app.activeDocument;
    if (stillOpen && (!active || active.id !== original.id)) ps.app.activeDocument = original;
  } catch {
    // the original document may have been closed meanwhile
  }
}

// ---------- save ----------

// A never-saved document has no path (reading it may throw); saving it in
// place would open a Save As dialog.
function hasFile(d) {
  try {
    return typeof d.path === "string" && d.path.length > 0;
  } catch {
    return false;
  }
}

async function save(ps, args = {}) {
  const { format, path } = args;
  if (format !== "psd" && format !== "jpg") throw invalid(`format must be psd or jpg, got ${format}`);
  if (path !== undefined && path !== null) requireFilePath(path, [`.${format}`]);
  const { d } = resolveDoc(ps, args.doc);
  if ((path === undefined || path === null) && !hasFile(d)) {
    throw invalid("document has never been saved; give a path");
  }
  return runRead(ps, "Claude: save", async () => {
    if (path === undefined || path === null) {
      await d.save();
      return { path: null };
    }
    const file = await fileEntry(ps, path);
    // PSD rebinds the document to the new file; a JPG is always written as a
    // copy, so the open document keeps its layers' file.
    if (format === "psd") await d.saveAs.psd(file, { embedColorProfile: true, maximizeCompatibility: true }, false);
    else await d.saveAs.jpg(file, { quality: 12, embedColorProfile: true }, true);
    return { path };
  });
}

module.exports = { crop, export: exportJpg, save };
