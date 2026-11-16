// Document and layer helpers. Receives `ps` (see lib/ps.js) as a parameter so it runs under Node with a stub.

function list(collection) {
  return collection ? Array.from(collection) : [];
}

function safe(read, fallback) {
  try {
    const v = read();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

// Bits per channel as a number. UXP returns the BitsPerChannelType enum
// string ("bitDepth8", "bitDepth16", "bitDepth32"); older stubs a number.
// Anything else is 0 so the summary still serializes as a number.
function bitsOf(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const m = /bitDepth(\d+)/i.exec(String(v));
  return m ? Number(m[1]) : 0;
}

// A finite number, else 0 (a NaN would fail the server's schema).
function finite(read) {
  const n = Number(safe(read, 0));
  return Number.isFinite(n) ? n : 0;
}

function propDescriptor(docId, id, property) {
  return {
    _obj: "get",
    _target: [{ _property: property }, { _ref: "layer", _id: id }, { _ref: "document", _id: docId }],
    _options: { dialogOptions: "dontDisplay" },
  };
}

const maskDescriptor = (docId, id) => propDescriptor(docId, id, "hasUserMask");

function collectIds(layers, ids = []) {
  for (const layer of list(layers)) {
    ids.push(layer.id);
    collectIds(safe(() => layer.layers, null), ids);
  }
  return ids;
}

// Has-mask flags: one batchPlay for the whole tree; if it throws, ask per
// layer (false on error). Returns id -> boolean.
async function hasMaskMap(ps, doc, ids) {
  const masks = new Map();
  if (ids.length === 0) return masks;
  try {
    const res = await ps.action.batchPlay(
      ids.map((id) => maskDescriptor(doc.id, id)),
      { synchronousExecution: true },
    );
    ids.forEach((id, i) => masks.set(id, !!(res && res[i] && res[i].hasUserMask)));
    return masks;
  } catch {}
  for (const id of ids) {
    try {
      const res = await ps.action.batchPlay([maskDescriptor(doc.id, id)], { synchronousExecution: true });
      masks.set(id, !!(res && res[0] && res[0].hasUserMask));
    } catch {
      masks.set(id, false);
    }
  }
  return masks;
}

// id -> {has, enabled}. enabled is read with one more batched get, only for
// the layers that have a mask; null when the layer has no mask or the read fails.
async function maskMap(ps, doc) {
  const ids = collectIds(doc.layers);
  const has = await hasMaskMap(ps, doc, ids);
  const masked = ids.filter((id) => has.get(id) === true);
  const enabled = new Map();
  if (masked.length > 0) {
    try {
      const res = await ps.action.batchPlay(
        masked.map((id) => propDescriptor(doc.id, id, "userMaskEnabled")),
        { synchronousExecution: true },
      );
      masked.forEach((id, i) => {
        const v = res && res[i] && res[i].userMaskEnabled;
        if (typeof v === "boolean") enabled.set(id, v);
      });
    } catch {}
  }
  const out = new Map();
  for (const id of ids) {
    const h = has.get(id) === true;
    out.set(id, { has: h, enabled: h && enabled.has(id) ? enabled.get(id) : null });
  }
  return out;
}

// A bounds edge may be a number or a unit value ({_value} or {value}).
function edge(v) {
  if (v !== null && typeof v === "object") v = "_value" in v ? v._value : v.value;
  return Number(v);
}

// {left, top, right, bottom} as plain numbers (unit values unwrapped); null for no box.
function normEdges(b) {
  if (!b) return null;
  return { left: edge(b.left), top: edge(b.top), right: edge(b.right), bottom: edge(b.bottom) };
}

// Like normEdges, but null for an empty box (all zeros, right <= left,
// bottom <= top) or one with a non-finite edge.
function normBounds(b) {
  const n = normEdges(b);
  if (!n) return null;
  if (!Object.values(n).every(Number.isFinite)) return null;
  if (n.right <= n.left || n.bottom <= n.top) return null;
  return n;
}

// Pixel bounds without layer effects (a drop shadow does not move them); null when empty.
function layerBounds(layer) {
  return normBounds(safe(() => layer.boundsNoEffects, null) || safe(() => layer.bounds, null));
}

const nullable = (read) => safe(read, null);

function round(n, places = 0) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// Text properties of a text layer, each null when it cannot be read.
function textInfo(layer) {
  const item = nullable(() => layer.textItem);
  if (!item) return { content: null, font: null, style: null, size_pt: null, color: null, justification: null };
  const cs = nullable(() => item.characterStyle);
  const font = cs ? nullable(() => String(cs.font)) : null;
  let style = cs ? nullable(() => cs.fontStyle) : null;
  if (style === null && font && font.includes("-")) style = font.slice(font.lastIndexOf("-") + 1);
  const sizeRaw = cs ? nullable(() => cs.size) : null;
  const size = sizeRaw === null ? NaN : Number(typeof sizeRaw === "object" ? edge(sizeRaw) : sizeRaw);
  let color = null;
  const rgb = cs ? nullable(() => cs.color.rgb) : null;
  if (rgb) {
    const c = { r: Number(rgb.red), g: Number(rgb.green), b: Number(rgb.blue) };
    if (Object.values(c).every(Number.isFinite)) color = { r: round(c.r), g: round(c.g), b: round(c.b) };
  }
  const just = nullable(() => item.paragraphStyle.justification);
  const content = nullable(() => item.contents);
  return {
    content: content === null ? null : String(content),
    font,
    style: style === null ? null : String(style),
    size_pt: Number.isFinite(size) ? round(size, 2) : null,
    color,
    justification: just === null ? null : String(just),
  };
}

function adjustmentDescriptor(docId, id) {
  return {
    _obj: "get",
    _target: [{ _property: "adjustment" }, { _ref: "layer", _id: id }, { _ref: "document", _id: docId }],
    _options: { dialogOptions: "dontDisplay" },
  };
}

function collectLayers(layers, out = []) {
  for (const layer of list(layers)) {
    out.push(layer);
    collectLayers(safe(() => layer.layers, null), out);
  }
  return out;
}

// Photoshop's Light layer is the brightness/contrast layer in light mode, so
// layer.kind says "brightnessContrast" for both. One batched get of the
// adjustment property tells them apart; on any failure the raw kind stands.
async function kindOverrides(ps, doc) {
  const kinds = new Map();
  const candidates = collectLayers(doc.layers).filter(
    (layer) => String(safe(() => layer.kind, "")) === "brightnessContrast",
  );
  if (candidates.length === 0) return kinds;
  try {
    const res = await ps.action.batchPlay(
      candidates.map((layer) => adjustmentDescriptor(doc.id, layer.id)),
      { synchronousExecution: true },
    );
    candidates.forEach((layer, i) => {
      const adj = res && res[i] && res[i].adjustment;
      const first = Array.isArray(adj) ? adj[0] : adj;
      const mode = first && first.brightnessMode && first.brightnessMode._value;
      if (mode === "brightnessModeLight") kinds.set(layer.id, "light");
    });
  } catch {}
  return kinds;
}

function layerSummary(layer, masks, kinds = new Map(), detail = false) {
  const mask = masks.get(layer.id) || { has: false, enabled: null };
  const kind = kinds.get(layer.id) || String(safe(() => layer.kind, "unknown"));
  const out = {
    id: layer.id,
    name: String(safe(() => layer.name, "")),
    kind,
    visible: !!safe(() => layer.visible, true),
    opacity: Number(safe(() => layer.opacity, 100)),
    blend: String(safe(() => layer.blendMode, "normal")),
    clipped: !!safe(() => layer.isClippingMask, false),
    hasMask: mask.has === true,
    maskEnabled: mask.has === true ? mask.enabled : null,
    bounds: layerBounds(layer),
  };
  if (detail && kind === "text") out.text = textInfo(layer);
  out.children = list(safe(() => layer.layers, null)).map((child) => layerSummary(child, masks, kinds, detail));
  return out;
}

// opts.detail (get_document only): text layers also carry their text properties.
async function docSummary(ps, doc, { detail = false } = {}) {
  if (!doc) return null;
  const masks = await maskMap(ps, doc);
  const kinds = await kindOverrides(ps, doc);
  const layers = list(doc.layers).map((layer) => layerSummary(layer, masks, kinds, detail));
  const active = safe(() => list(doc.activeLayers)[0], null);
  return {
    id: doc.id,
    name: String(doc.name ?? doc.title ?? ""),
    width: finite(() => doc.width),
    height: finite(() => doc.height),
    ppi: finite(() => doc.resolution),
    profile: String(safe(() => doc.colorProfileName, "")),
    bits: bitsOf(safe(() => doc.bitsPerChannel, 8)),
    activeLayerId: active ? active.id : null,
    layers,
  };
}

function findLayer(doc, id) {
  const walk = (layers) => {
    for (const layer of list(layers)) {
      if (layer.id === id) return layer;
      const found = walk(safe(() => layer.layers, null));
      if (found) return found;
    }
    return null;
  };
  return doc ? walk(doc.layers) : null;
}

// One layer's user-mask flag; false when the query fails.
async function hasUserMask(ps, docId, layerId) {
  try {
    const res = await ps.action.batchPlay([maskDescriptor(docId, layerId)], { synchronousExecution: true });
    return !!(res && res[0] && res[0].hasUserMask);
  } catch {
    return false;
  }
}

// Strict variant: a failed query throws MASK_QUERY_FAILED instead of guessing "no mask".
async function hasUserMaskStrict(ps, docId, layerId) {
  let res;
  try {
    res = await ps.action.batchPlay([maskDescriptor(docId, layerId)], { synchronousExecution: true });
  } catch (e) {
    const err = new Error(`Could not read the mask state of layer ${layerId}: ${(e && e.message) || e}`);
    err.code = "MASK_QUERY_FAILED";
    throw err;
  }
  const r = res && res[0];
  if (!r || r._obj === "error" || typeof r.hasUserMask !== "boolean") {
    const err = new Error(`Could not read the mask state of layer ${layerId}`);
    err.code = "MASK_QUERY_FAILED";
    throw err;
  }
  return r.hasUserMask;
}

// ---------- modal state ----------

const PROBE_TIMEOUT_S = 1;

function hasLayerNamed(doc, name) {
  return collectLayers(safe(() => doc.layers, null)).some((l) => safe(() => l.name, "") === name);
}

// The kind for Photoshop's current tool while it is modal; null if unreadable.
async function toolKind(ps) {
  try {
    const res = await ps.action.batchPlay(
      [{
        _obj: "get",
        _target: [{ _property: "tool" }, { _ref: "application", _enum: "ordinal", _value: "targetEnum" }],
        _options: { dialogOptions: "dontDisplay" },
      }],
      { synchronousExecution: true },
    );
    const t = res && res[0] && res[0].tool;
    const id = t && typeof t === "object" ? t._value || t._enum || t.ID : t;
    if (typeof id !== "string" || id === "") return null;
    if (id === "cropTool") return "crop";
    if (id === "typeCreateOrEditTool" || id === "typeVerticalCreateOrEditTool") return "text";
    return "transform";
  } catch {
    return null;
  }
}

// null when a modal scope can be entered; otherwise what holds Photoshop:
// "crop" | "text" | "transform" | "dialog" | "busy" (another plugin, error 9) | "unknown".
// hint: what Photoshop's own modal events say (dev.modalHint()), used only
// once the probe has failed; the probe is the source of truth.
async function modalState(ps, doc, hint = null) {
  try {
    await ps.core.executeAsModal(async () => {}, {
      commandName: "pslab modal probe",
      interactive: false,
      timeOut: PROBE_TIMEOUT_S,
    });
    return null;
  } catch (e) {
    try {
      if (doc && hasLayerNamed(doc, "Crop Preview")) return "crop";
      if (e && e.number === 9) return "busy";
      if (hint) return hint;
      return (await toolKind(ps)) || "unknown";
    } catch {
      return "unknown";
    }
  }
}

function modalBusy(kind) {
  const e = new Error(`Photoshop is in a modal state (${kind}); commit or cancel it, then retry`);
  e.code = "MODAL_BUSY";
  return e;
}

async function requireNotModal(ps, doc, hint = null) {
  const kind = await modalState(ps, doc, hint);
  if (kind) throw modalBusy(kind);
}

function noDocument(message) {
  const e = new Error(message);
  e.code = "NO_DOCUMENT";
  return e;
}

// The document with id docId, or the active one when docId is omitted.
function resolveDoc(ps, docId) {
  const docs = Array.from(ps.app.documents || []);
  if (docs.length === 0) throw noDocument("No document open");
  let d;
  if (docId !== undefined && docId !== null) {
    d = docs.find((x) => x.id === docId);
    if (!d) throw noDocument(`No document with id ${docId}`);
  } else {
    d = ps.app.activeDocument;
    if (!d) throw noDocument("No document open");
  }
  return { d, docs };
}

// Callers run this inside their own executeAsModal.
async function selectLayer(ps, doc, id) {
  return ps.action.batchPlay(
    [
      {
        _obj: "select",
        _target: [{ _ref: "layer", _id: id }],
        makeVisible: false,
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {},
  );
}

module.exports = {
  bitsOf, docSummary, findLayer, kindOverrides, selectLayer, hasUserMask, hasUserMaskStrict, resolveDoc,
  normEdges, normBounds, layerBounds, textInfo, safe,
  modalState, requireNotModal, modalBusy,
};
