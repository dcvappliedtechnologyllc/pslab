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

function maskDescriptor(docId, id) {
  return {
    _obj: "get",
    _target: [{ _property: "hasUserMask" }, { _ref: "layer", _id: id }, { _ref: "document", _id: docId }],
    _options: { dialogOptions: "dontDisplay" },
  };
}

function collectIds(layers, ids = []) {
  for (const layer of list(layers)) {
    ids.push(layer.id);
    collectIds(safe(() => layer.layers, null), ids);
  }
  return ids;
}

// One batchPlay for the whole tree; if it throws, ask per layer (false on error).
async function maskMap(ps, doc) {
  const ids = collectIds(doc.layers);
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

function layerSummary(layer, masks, kinds = new Map()) {
  return {
    id: layer.id,
    name: String(safe(() => layer.name, "")),
    kind: kinds.get(layer.id) || String(safe(() => layer.kind, "unknown")),
    visible: !!safe(() => layer.visible, true),
    opacity: Number(safe(() => layer.opacity, 100)),
    blend: String(safe(() => layer.blendMode, "normal")),
    clipped: !!safe(() => layer.isClippingMask, false),
    hasMask: masks.get(layer.id) === true,
    children: list(safe(() => layer.layers, null)).map((child) => layerSummary(child, masks, kinds)),
  };
}

async function docSummary(ps, doc) {
  if (!doc) return null;
  const masks = await maskMap(ps, doc);
  const kinds = await kindOverrides(ps, doc);
  const layers = list(doc.layers).map((layer) => layerSummary(layer, masks, kinds));
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

module.exports = { bitsOf, docSummary, findLayer, selectLayer, hasUserMask, hasUserMaskStrict, resolveDoc };
