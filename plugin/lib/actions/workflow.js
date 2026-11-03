// Shoot workflow actions: carry an adjustment stack from one shot to the
// next, open a whole folder, compare before/after, and lay out a contact
// sheet. Validation happens before any modal scope so a rejected call never
// creates a history state.
const D = require("../descriptors");
const { runStep, runScratch, runRead, bp } = require("../step");
const { findLayer, resolveDoc } = require("../doc");
const { resolvePasted, allIds, activate, restore } = require("./composite");
const { openEntry } = require("./see");
const { toRgb, stitchSideBySide, tileGrid } = require("../tile");

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const invalidArgs = (message) => codedError("INVALID_ARGS", message);

function safe(read, fallback) {
  try {
    const v = read();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

// Every layer of the tree, top of the stack first (doc.layers[0] is the top).
function flatten(layers, out = []) {
  for (const layer of Array.from(layers || [])) {
    out.push(layer);
    flatten(safe(() => layer.layers, null), out);
  }
  return out;
}

function isBackground(layer) {
  if (safe(() => layer.isBackgroundLayer, false) === true) return true;
  return safe(() => layer.name, "") === "Background" && String(safe(() => layer.kind, "")) === "pixel";
}

// ---------- copy_layers_to ----------

// Layer > Arrange > Bring to Front through the DOM. The batchPlay form
// ({_obj:"move", _target:[{_ref:"layer",_id}], to:{_ref:"layer",_enum:"ordinal",_value:"front"}})
// failed live on PS 27.11 with an empty message, so it is not used.
async function bringToFront(ps, dst, layer) {
  if (typeof layer.bringToFront === "function") return layer.bringToFront();
  const top = Array.from(dst.layers || [])[0];
  return layer.move(top, ps.constants.ElementPlacement.PLACEBEFORE);
}

async function copy_layers_to(ps, args = {}) {
  const ids = args.layers;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(Number.isInteger)) {
    throw invalidArgs("layers must be a non-empty list of layer ids");
  }
  if (new Set(ids).size !== ids.length) throw invalidArgs("layers lists the same id twice");
  const { d: src } = resolveDoc(ps, args.src_doc);
  const { d: dst } = resolveDoc(ps, args.dst_doc);
  if (src.id === dst.id) throw codedError("SAME_DOCUMENT", "src_doc and dst_doc must differ");
  const layers = ids.map((id) => {
    const layer = findLayer(src, id);
    if (!layer) throw codedError("NO_LAYER", `No layer with id ${id} in document ${src.id}`);
    if (isBackground(layer)) throw invalidArgs("Background cannot be copied");
    return layer;
  });

  // Bottom-most first: each copy is moved to the top of dst, so the last one
  // copied (the top-most in src) ends on top and the stack order matches src.
  const order = new Map(flatten(src.layers).map((layer, i) => [layer.id, i]));
  const bottomFirst = layers.slice().sort((a, b) => order.get(b.id) - order.get(a.id));

  const original = ps.app.activeDocument;
  const name = `Claude: copy_layers_to, ${ids.length} layer${ids.length === 1 ? "" : "s"}`;
  // Only dst changes, so one history state there; src is left as it was (the
  // DOM duplicate needs neither src active nor its layer selected).
  return runStep(ps, name, dst.id, async () => {
    try {
      const copied = new Map();
      activate(ps, dst);
      for (const layer of bottomFirst) {
        const before = allIds(dst.layers);
        // A DOM duplicate into another document keeps the layer mask
        // (verified live in the P3 bring-up).
        const made = resolvePasted(dst, before, await layer.duplicate(dst));
        if (!made) throw codedError("COPY_FAILED", `The copy of layer ${layer.id} was not found in the destination`);
        const top = Array.from(dst.layers || [])[0];
        if (!top || top.id !== made.id) await bringToFront(ps, dst, made);
        copied.set(layer.id, made);
      }
      // dst stays active so the next tool (and a look in Photoshop) lands there.
      return {
        layer_ids: ids.map((id) => copied.get(id).id),
        names: ids.map((id) => String(safe(() => copied.get(id).name, ""))),
      };
    } catch (e) {
      restore(ps, original);
      throw e;
    }
  });
}

// ---------- open_folder ----------

const MAX_FOLDER_FILES = 50;
const DEFAULT_EXTENSIONS = ["jpg", "jpeg", "heic", "heif", "png", "tif", "tiff", "psd"];

// A case-insensitive glob with * and ? only; null pattern = the default image
// extensions (a plain list, not brace expansion).
function nameMatcher(pattern) {
  if (pattern === undefined || pattern === null) {
    return (name) => {
      const dot = name.lastIndexOf(".");
      return dot > 0 && DEFAULT_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
    };
  }
  const body = pattern
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&")))
    .join("");
  const re = new RegExp(`^${body}$`, "i");
  return (name) => re.test(name);
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

async function open_folder(ps, args = {}) {
  const path = args.path;
  if (typeof path !== "string" || !path.startsWith("/")) throw invalidArgs("path must be an absolute folder path");
  const pattern = args.pattern;
  if (pattern !== undefined && pattern !== null && (typeof pattern !== "string" || pattern === "" || pattern.includes("/"))) {
    throw invalidArgs("pattern must be a non-empty file name glob (* and ?) without /");
  }
  let folder;
  try {
    folder = await ps.fs.getEntryWithUrl("file:" + path);
  } catch (e) {
    throw codedError("FILE_NOT_FOUND", `cannot read ${path}: ${String((e && e.message) || e)}`);
  }
  if (!folder || !folder.isFolder) throw invalidArgs(`${path} is not a folder`);
  const matches = nameMatcher(pattern);
  const files = Array.from(await folder.getEntries())
    .filter((e) => e && e.isFile && matches(String(e.name)))
    .sort(byName);
  if (files.length > MAX_FOLDER_FILES) {
    throw codedError("TOO_MANY_FILES", `${files.length} files match; open_folder opens at most ${MAX_FOLDER_FILES}. Narrow it with pattern.`);
  }
  const dir = path.replace(/\/+$/, "");
  const opened = [];
  let failed = null;
  if (files.length > 0) {
    // One modal scope for the whole folder; a file that fails stops the run
    // and the documents opened before it stay open.
    await runRead(ps, "Open folder", async () => {
      for (const entry of files) {
        try {
          const d = await openEntry(ps, entry);
          opened.push({ id: d.id, name: d.name, path: `${dir}/${entry.name}` });
        } catch (e) {
          failed = { name: String(entry.name), message: String((e && e.message) || e) };
          return;
        }
      }
    });
  }
  if (failed) {
    throw codedError(
      "OPEN_FAILED",
      `${failed.name} could not be opened (${failed.message}); ${opened.length} of ${files.length} opened before it stay open: ` +
        JSON.stringify({ opened, failed }),
    );
  }
  const docs = Array.from(ps.app.documents || []);
  return {
    docs: opened,
    count: opened.length,
    open_docs: docs.map((x) => ({ id: x.id, name: x.name })),
  };
}

// ---------- shared by compare_preview and contact_sheet ----------

const GAP_PX = 8;
const isInt = (v) => Number.isInteger(v);

// getPixels targetSize that fits a w x h canvas inside maxW x maxH (one side,
// the other scales proportionally), or null when it already fits.
function fitTarget(w, h, maxW, maxH) {
  if (w <= maxW && h <= maxH) return null;
  return maxW / w <= maxH / h ? { width: maxW } : { height: maxH };
}

// The whole-canvas composite as a chunky RGB copy {data, width, height}; the
// imageData is disposed before returning.
async function readComposite(ps, d, targetSize) {
  const opts = {
    documentID: d.id,
    sourceBounds: { left: 0, top: 0, right: Number(d.width), bottom: Number(d.height) },
    componentSize: 8,
    applyAlpha: true,
    // Grayscale, CMYK or Lab documents would otherwise come back in their own mode.
    colorSpace: "RGB",
  };
  if (targetSize) opts.targetSize = targetSize;
  const { imageData } = await ps.imaging.getPixels(opts);
  try {
    const raw = await imageData.getData({ chunky: true });
    const count = imageData.width * imageData.height;
    return { data: toRgb(raw, imageData.components, count).slice(), width: imageData.width, height: imageData.height };
  } finally {
    imageData.dispose();
  }
}

// JPEG (base64) of an RGB buffer: encodeImageData takes an imageData, so the
// buffer is wrapped first and the wrapper disposed afterwards.
async function encodeRgb(ps, img) {
  const imageData = await ps.imaging.createImageDataFromBuffer(img.data, {
    width: img.width,
    height: img.height,
    components: 3,
    colorSpace: "RGB",
    colorProfile: "sRGB IEC61966-2.1",
    chunky: true,
  });
  try {
    return await ps.imaging.encodeImageData({ imageData, base64: true });
  } finally {
    imageData.dispose();
  }
}

function maxPxArg(v, lo, hi) {
  const maxPx = v ?? 1500;
  if (!isInt(maxPx) || maxPx < lo || maxPx > hi) throw invalidArgs(`max_px must be an integer from ${lo} to ${hi}`);
  return maxPx;
}

// ---------- compare_preview ----------

async function compare_preview(ps, args = {}) {
  const ids = args.layer_ids_off;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isInt)) {
    throw invalidArgs("layer_ids_off must be a non-empty list of layer ids");
  }
  const maxPx = maxPxArg(args.max_px, 200, 4000);
  const { d } = resolveDoc(ps, args.doc);
  const layers = ids.map((id) => {
    const layer = findLayer(d, id);
    if (!layer) throw codedError("NO_LAYER", `No layer with id ${id}`);
    return layer;
  });
  const w = Number(d.width);
  const h = Number(d.height);
  // Both halves plus the gap fit in max_px, so each half is under max_px / 2 wide.
  const targetSize = fitTarget(w, h, Math.floor((maxPx - GAP_PX) / 2), maxPx);
  const original = ps.app.activeDocument;

  // runScratch always rolls back: hiding the layers leaves no history state.
  return runScratch(ps, "Claude: compare_preview", d.id, async () => {
    const saved = layers.map((layer) => [layer, safe(() => layer.visible, true)]);
    try {
      activate(ps, d);
      const after = await readComposite(ps, d, targetSize);
      for (const layer of layers) layer.visible = false;
      const before = await readComposite(ps, d, targetSize);
      const sheet = stitchSideBySide(before, after, GAP_PX);
      const jpeg_base64 = await encodeRgb(ps, sheet);
      return {
        jpeg_base64,
        preview: { w: sheet.width, h: sheet.height },
        half: { w: after.width, h: after.height },
        left: "before",
        right: "after",
        scale: w / after.width,
        layers_off: ids.slice(),
      };
    } finally {
      // Belt and braces: the rollback restores visibility too.
      for (const [layer, visible] of saved) {
        try {
          layer.visible = visible;
        } catch {}
      }
      restore(ps, original);
    }
  });
}

// ---------- contact_sheet ----------

const MAX_SHEET_DOCS = 24;
const MIN_CELL_PX = 16;

async function contact_sheet(ps, args = {}) {
  const ids = args.docs;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SHEET_DOCS || !ids.every(isInt)) {
    throw invalidArgs(`docs must list 1 to ${MAX_SHEET_DOCS} document ids`);
  }
  const n = ids.length;
  const cols = args.cols ?? Math.ceil(Math.sqrt(n));
  if (!isInt(cols) || cols < 1 || cols > 8) throw invalidArgs("cols must be an integer from 1 to 8");
  const maxPx = maxPxArg(args.max_px, 400, 4000);
  const docs = ids.map((id) => resolveDoc(ps, id).d);
  const rows = Math.ceil(n / cols);
  // max_px is the long edge of the sheet: the side with more cells sets the cell size.
  const across = Math.max(cols, rows);
  const cell = Math.floor((maxPx - GAP_PX * (across + 1)) / across);
  if (cell < MIN_CELL_PX) throw invalidArgs(`cells would be ${cell} px; raise max_px or cols`);

  return runRead(ps, "Contact sheet", async () => {
    const images = [];
    for (const d of docs) {
      images.push(await readComposite(ps, d, fitTarget(Number(d.width), Number(d.height), cell, cell)));
    }
    const sheet = tileGrid(images, { cols, cell, gap: GAP_PX, bg: 128 });
    const jpeg_base64 = await encodeRgb(ps, sheet);
    return {
      jpeg_base64,
      sheet: { w: sheet.width, h: sheet.height, cols, rows, cell },
      cells: docs.map((d, i) => ({ doc: d.id, name: String(d.name ?? d.title ?? ""), ...sheet.placements[i] })),
    };
  });
}

module.exports = { copy_layers_to, open_folder, compare_preview, contact_sheet, nameMatcher, fitTarget };
