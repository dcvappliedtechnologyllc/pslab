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

// Largest box of the given aspect inside w x h. Centred on the canvas, or on
// focus {x, y} (image px) and then shifted so it stays fully inside the canvas.
function ratioBox(w, h, ratio, focus) {
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
  let left;
  let top;
  if (focus) {
    const clamp = (v, max) => Math.min(Math.max(v, 0), max);
    left = clamp(Math.floor(focus.x - cw / 2), w - cw);
    top = clamp(Math.floor(focus.y - ch / 2), h - ch);
  } else {
    left = Math.floor((w - cw) / 2);
    top = Math.floor((h - ch) / 2);
  }
  return { left, top, right: left + cw, bottom: top + ch };
}

// focus must be {x, y} finite numbers inside the canvas; undefined/null means none.
function checkFocus(focus, w, h) {
  if (focus === undefined || focus === null) return undefined;
  const ok =
    typeof focus === "object" && Number.isFinite(focus.x) && Number.isFinite(focus.y) &&
    focus.x >= 0 && focus.y >= 0 && focus.x <= w && focus.y <= h;
  if (!ok) throw invalid(`focus must be {x, y} inside the ${w}x${h} document, got ${JSON.stringify(focus)}`);
  return { x: focus.x, y: focus.y };
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
  const hasFocus = args.focus !== undefined && args.focus !== null;
  if (hasRatio === hasBox) throw invalid("crop needs exactly one of ratio or bbox");
  if (hasFocus && hasBox) throw invalid("focus only applies to a ratio crop, not to bbox");
  const { d } = resolveDoc(ps, args.doc);
  const w = Number(d.width);
  const h = Number(d.height);
  const focus = checkFocus(args.focus, w, h);
  const bbox = hasRatio ? ratioBox(w, h, args.ratio, focus) : checkBox(args.bbox, w, h);
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

// Instagram presets: crop the temporary copy to the aspect, then size the long edge.
const PRESETS = {
  post: { ratio: "4:5", longEdge: 1350 }, // 1080x1350 portrait feed post
  story: { ratio: "9:16", longEdge: 1920 }, // 1080x1920 story / reel cover
};

async function exportJpg(ps, args = {}) {
  const { path, quality, preset } = args;
  const hasPreset = preset !== undefined && preset !== null;
  const hasFocus = args.focus !== undefined && args.focus !== null;
  requireFilePath(path, [".jpg"]);
  if (hasPreset && !Object.prototype.hasOwnProperty.call(PRESETS, preset)) {
    throw invalid(`preset must be post or story, got ${preset}`);
  }
  if (hasFocus && !hasPreset) throw invalid("focus only applies with a preset");
  // A preset sets the long edge itself; long_edge_px is ignored then.
  const longEdge = hasPreset ? PRESETS[preset].longEdge : args.long_edge_px;
  if (!isInt(longEdge) || longEdge < 1) throw invalid(`long_edge_px must be a positive whole number, got ${longEdge}`);
  if (!isInt(quality) || quality < 1 || quality > 12) throw invalid(`quality must be a whole number 1..12, got ${quality}`);
  const { d } = resolveDoc(ps, args.doc);
  let cropBox = null;
  if (hasPreset) {
    const w = Number(d.width);
    const h = Number(d.height);
    cropBox = ratioBox(w, h, PRESETS[preset].ratio, checkFocus(args.focus, w, h));
  }
  return runRead(ps, `Claude: export ${splitPath(path).base}`, async () => {
    // duplicate() makes the copy active and closing it lets Photoshop pick the
    // next tab, so the active document is put back afterwards on every path.
    const original = ps.app.activeDocument;
    try {
      const result = await exportCopy(ps, d, path, longEdge, quality, cropBox);
      return hasPreset ? { ...result, preset, crop_bbox: cropBox } : result;
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
// cropBox (a preset's ratio box, in original pixels: the copy has the same
// size) is applied to the copy only, so a preset export is the non-destructive
// route to a ratio export, unlike crop. Order: flatten, crop, convertProfile,
// bits, resize, save.
async function exportCopy(ps, d, path, longEdge, quality, cropBox = null) {
  const copy = await d.duplicate("pslab export", true);
  let result;
  try {
    if (layerCount(copy) !== 1) await copy.flatten();
    if (cropBox) await copy.crop(cropBox);
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

// ---------- save_psd ----------

const PSD_SOURCE_EXT = /\.(psd|jpe?g|heic|png|tiff?)$/i;

// IMG_0118.JPG -> IMG_0118; a name without a known extension stays as it is.
// Path separators in a document name would escape the folder, so they become "-".
function psdStem(name) {
  const stem = String(name || "").replace(PSD_SOURCE_EXT, "").replace(/[/:\\]/g, "-");
  return stem && !stem.startsWith(".") ? stem : "untitled";
}

function requireFolder(folder) {
  if (typeof folder !== "string" || !folder.startsWith("/") || folder.split("/").includes("..")) {
    throw invalid(`folder must be an absolute path without .., got ${folder}`);
  }
  return folder.length > 1 ? folder.replace(/\/+$/, "") : folder;
}

async function exists(fs, p) {
  try {
    await fs.getEntryWithUrl("file:" + p);
    return true;
  } catch {
    return false;
  }
}

// First free name in folder: <stem>.psd, else <stem>-2.psd ... <stem>-99.psd.
// When the document itself is <folder>/<stem>.psd the stem becomes <stem>-edit,
// so the source file is never the target.
async function psdTarget(ps, d, folder) {
  let stem = psdStem(d.name);
  const join = (name) => (folder === "/" ? "/" : folder + "/") + name;
  if (hasFile(d) && d.path.toLowerCase() === join(stem + ".psd").toLowerCase()) stem += "-edit";
  for (let n = 1; n <= 99; n++) {
    const name = n === 1 ? `${stem}.psd` : `${stem}-${n}.psd`;
    const target = join(name);
    const isSource = hasFile(d) && d.path.toLowerCase() === target.toLowerCase();
    if (!isSource && !(await exists(ps.fs, target))) return { name, target };
  }
  throw codedError("SAVE_EXISTS", `${join(stem + ".psd")} and -2 .. -99 all exist; choose another folder`);
}

// Writes a layered PSD copy into folder and never overwrites any file
// (createFile overwrite: false, and the name is probed first). Unlike
// save format:psd, which rebinds the open document to the new file, this
// saves AS A COPY: the open document keeps referring to its own file.
// No history state; nothing in the document changes.
async function savePsd(ps, args = {}) {
  const folder = requireFolder(args.folder);
  const { d } = resolveDoc(ps, args.doc);
  return runRead(ps, "Claude: save_psd", async () => {
    const { name, target } = await psdTarget(ps, d, folder);
    const parent = await ensureFolder(ps.fs, folder);
    let file;
    try {
      file = await parent.createFile(name, { overwrite: false });
    } catch (e) {
      throw codedError("SAVE_EXISTS", `Could not create ${target} without overwriting: ${(e && e.message) || e}`);
    }
    try {
      await d.saveAs.psd(file, { embedColorProfile: true, maximizeCompatibility: true }, true);
    } catch (e) {
      // createFile already made an empty file: remove it so a failed save
      // leaves no 0-byte PSD behind.
      try {
        await file.delete();
      } catch {
        // the save error wins
      }
      throw codedError("SAVE_FAILED", `Could not save ${target}: ${(e && e.message) || e}`);
    }
    return { path: target, layers: layerCount(d) };
  });
}

module.exports = { crop, export: exportJpg, save, save_psd: savePsd, ratioBox, psdStem };
