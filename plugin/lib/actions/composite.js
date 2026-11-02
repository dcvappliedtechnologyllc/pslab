// Composite actions: select an object, copy a layer (or the selected part of
// it) from one document into another, scaled and centered at a pixel, then
// finish it: refine its edge, match its tone, blur it to the shot's sharpness.
// Validation happens before runStep so a rejected call never creates a state.
const D = require("../descriptors");
const { runStep, runSteps, runRead, bp } = require("../step");
const { findLayer, resolveDoc, hasUserMaskStrict } = require("../doc");
const { clampBbox } = require("../stats");
const defaultRecorded = require("../recorded/index");

// Test hook: replace the recorded-descriptor map (null restores the files).
let recordedOverride = null;
function setRecorded(map) {
  recordedOverride = map;
}
const recordedMap = () => recordedOverride || defaultRecorded;

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function validBbox(bbox) {
  return !!bbox && ["left", "top", "right", "bottom"].every((k) => isNum(bbox[k])) &&
    bbox.left < bbox.right && bbox.top < bbox.bottom;
}

// A bounds edge may be a number or a unit value ({_value} or {value}).
function edge(v) {
  if (v !== null && typeof v === "object") v = "_value" in v ? v._value : v.value;
  return Number(v);
}

function norm(b) {
  if (!b) return null;
  return { left: edge(b.left), top: edge(b.top), right: edge(b.right), bottom: edge(b.bottom) };
}

const isEmpty = (b) =>
  !b || !Object.values(b).every(Number.isFinite) || b.right - b.left <= 0 || b.bottom - b.top <= 0;

function activate(ps, d) {
  const active = ps.app.activeDocument;
  if (!active || active.id !== d.id) ps.app.activeDocument = d;
}

function restore(ps, original) {
  try {
    if (original) activate(ps, original);
  } catch {
    // the original document may have been closed meanwhile
  }
}

function allIds(layers, ids = new Set()) {
  for (const layer of Array.from(layers || [])) {
    ids.add(layer.id);
    let children = null;
    try {
      children = layer.layers;
    } catch {}
    allIds(children, ids);
  }
  return ids;
}

function findByName(layers, name) {
  for (const layer of Array.from(layers || [])) {
    if (layer.name === name) return layer;
    let children = null;
    try {
      children = layer.layers;
    } catch {}
    const found = findByName(children, name);
    if (found) return found;
  }
  return null;
}

// ---------- select_object ----------

async function select_object(ps, args = {}) {
  const { bbox, mode } = args;
  if (mode !== "object" && mode !== "subject") throw codedError("INVALID_MODE", `mode must be object or subject, got ${mode}`);
  if (!validBbox(bbox)) throw codedError("INVALID_BBOX", "bbox needs numeric left < right and top < bottom");
  const { d } = resolveDoc(ps, args.doc);
  // The selection stays in d for copy_to; the previously active document is
  // active again afterwards.
  return stepIn(ps, `Claude: select_object, ${mode}`, d, async () => {
    await bp(ps, [D.selectRectangle(bbox), mode === "subject" ? D.selectSubject() : D.objectSelect(bbox)]);
    const bounds = norm(d.selection && d.selection.bounds);
    if (isEmpty(bounds)) throw codedError("EMPTY_SELECTION", "Nothing was selected inside bbox");
    return { bounds };
  });
}

// ---------- copy_to ----------

const applyMask = () => ({
  _obj: "delete",
  _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }],
  apply: true,
});

// The layer a duplicate into dst produced: the returned layer when it is new,
// else a dst layer (active first) whose id did not exist before.
function resolvePasted(dst, before, returned) {
  if (returned && !before.has(returned.id)) return findLayer(dst, returned.id) || returned;
  const top = Array.from(dst.activeLayers || [])[0];
  if (top && !before.has(top.id)) return top;
  const walk = (layers) => {
    for (const layer of Array.from(layers || [])) {
      if (!before.has(layer.id)) return layer;
      let children = null;
      try {
        children = layer.layers;
      } catch {}
      const found = walk(children);
      if (found) return found;
    }
    return null;
  };
  return walk(dst.layers);
}

// Profile fallback: copy the source document, convert it to the destination
// profile, and duplicate the temp layer from that copy. The copy is closed
// without saving, and registered for auto-close so a failure still closes it.
async function duplicateViaConvertedCopy(ps, ctx, src, dst, tempName) {
  const host = ctx && ctx.hostControl;
  const tmpDoc = await src.duplicate();
  let registered = false;
  try {
    if (host && typeof host.registerAutoCloseDocument === "function") {
      await host.registerAutoCloseDocument(tmpDoc.id);
      registered = true;
    }
    await tmpDoc.convertProfile(dst.colorProfileName, ps.constants.Intent.RELATIVECOLORIMETRIC);
    const layer = findByName(tmpDoc.layers, tempName);
    if (!layer) throw new Error("the temp layer was not found in the converted copy");
    return await layer.duplicate(dst);
  } finally {
    try {
      await tmpDoc.closeWithoutSaving();
      if (registered && typeof host.unregisterAutoCloseDocument === "function") {
        await host.unregisterAutoCloseDocument(tmpDoc.id);
      }
    } catch {
      // the auto-close registration closes it when the modal scope ends
    }
  }
}

const message = (e) => String((e && e.message) || e);

async function copy_to(ps, args = {}) {
  const t = args.transform || {};
  if (!isNum(t.scale_pct) || t.scale_pct <= 0 || !isNum(t.cx) || !isNum(t.cy)) {
    throw codedError("INVALID_TRANSFORM", "transform needs scale_pct > 0, cx and cy");
  }
  const useSelection = args.use_selection !== false;
  const { d: src } = resolveDoc(ps, args.src_doc);
  const { d: dst } = resolveDoc(ps, args.dst_doc);
  if (src.id === dst.id) throw codedError("SAME_DOCUMENT", "src_doc and dst_doc must differ");
  let srcLayer;
  if (args.src_layer !== undefined && args.src_layer !== null) {
    srcLayer = findLayer(src, args.src_layer);
    if (!srcLayer) throw codedError("NO_LAYER", `No layer with id ${args.src_layer}`);
  } else {
    srcLayer = Array.from(src.activeLayers || [])[0];
    if (!srcLayer) throw codedError("NO_LAYER", "The source document has no active layer");
  }
  if (useSelection && !(src.selection && src.selection.bounds)) {
    throw codedError("NO_SELECTION", "use_selection is true but the source document has no active selection");
  }

  const original = ps.app.activeDocument;
  const srcDocName = String(src.name ?? src.title ?? `document ${src.id}`);
  const defaultName = `${srcLayer.name} from ${srcDocName}`;
  const before = allIds(dst.layers);
  const tempName = `pslab copy_to temp ${Date.now()}`;
  const steps = [
    { docId: src.id, name: "Claude: copy_to, prep" },
    { docId: dst.id, name: `Claude: copy_to, ${args.name || "pasted"} @ ${t.cx},${t.cy} x${t.scale_pct}%` },
  ];

  // One modal, both documents suspended: any failure rolls back the temp layer
  // in src and the paste in dst, leaving no extra history states.
  // A second concurrent suspension is verified against live Photoshop in the phase 3 check.
  return runSteps(ps, steps, async (ctx) => {
    try {
      // src: masked temp copy of the layer
      activate(ps, src);
      await bp(ps, [D.selectLayerById(srcLayer.id)]);
      const dup = await srcLayer.duplicate();
      dup.name = tempName;
      if (useSelection) {
        await bp(ps, [D.selectLayerById(dup.id)]);
        await bp(ps, [D.makeMaskFromSelection("reveal")]);
        await bp(ps, [applyMask()]);
      }

      // dst: paste, falling back to a profile-converted copy
      let layer = null;
      let firstError = null;
      try {
        layer = resolvePasted(dst, before, await dup.duplicate(dst));
      } catch (e) {
        firstError = e;
      }
      if (!firstError && !layer) throw codedError("COPY_FAILED", "The copied layer was not found in the destination");
      if (firstError || isEmpty(norm(layer.bounds))) {
        if (layer) {
          layer.delete();
          layer = null;
        }
        try {
          layer = resolvePasted(dst, before, await duplicateViaConvertedCopy(ps, ctx, src, dst, tempName));
        } catch (e) {
          const first = firstError ? `${message(firstError)}; ` : "";
          throw codedError("COPY_FAILED", `Copy to the destination failed: ${first}fallback: ${message(e)}`);
        }
        if (!layer || isEmpty(norm(layer.bounds))) {
          const first = firstError ? ` (${message(firstError)})` : "";
          throw codedError("COPY_FAILED", `The copied layer is empty or missing in the destination${first}`);
        }
      }

      activate(ps, dst);
      const b = norm(layer.bounds);
      const dx = t.cx - (b.left + b.right) / 2;
      const dy = t.cy - (b.top + b.bottom) / 2;
      await bp(ps, [D.selectLayerById(layer.id), D.transform({ scalePct: t.scale_pct, dx, dy })]);
      layer.name = args.name || defaultName;
      const result = { layer_id: layer.id, bounds: norm(layer.bounds) };

      // src: drop the temp copy; dst stays active so the next layer tool
      // (and a look in Photoshop) lands on the pasted layer.
      await dup.delete();
      activate(ps, dst);
      return result;
    } catch (e) {
      restore(ps, original);
      throw e;
    }
  });
}

// ---------- shared by the finishing tools ----------

function requireLayer(d, id) {
  const layer = Number.isInteger(id) ? findLayer(d, id) : null;
  if (!layer) throw codedError("NO_LAYER", `No layer with id ${id}`);
  return layer;
}

const invalidArgs = (message) => codedError("INVALID_ARGS", message);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// One history step in d; the document active before the call is active again
// afterwards, on success and on failure.
function stepIn(ps, name, d, fn) {
  const original = ps.app.activeDocument;
  return runStep(ps, name, d.id, async () => {
    try {
      activate(ps, d);
      return await fn();
    } finally {
      restore(ps, original);
    }
  });
}

const activeId = (d) => {
  const layer = Array.from(d.activeLayers || [])[0];
  if (!layer) throw codedError("NO_NEW_LAYER", "The new layer was not found after creating it");
  return layer.id;
};

// ---------- refine_edge ----------

const loadTransparency = () => ({
  _obj: "set",
  _target: [{ _ref: "channel", _property: "selection" }],
  to: { _ref: "channel", _enum: "channel", _value: "transparencyEnum" },
});
const deleteMask = () => ({ _obj: "delete", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }] });

// The recorded defringe descriptor with its width set to `pixels`, or null
// when none is recorded (or it is marked unsupported).
function recordedDefringe(pixels) {
  const rec = recordedMap().defringe;
  if (!rec || rec.unsupported || typeof rec._obj !== "string") return null;
  const desc = JSON.parse(JSON.stringify(rec));
  desc.width = desc.width && typeof desc.width === "object" ? { ...desc.width, _value: pixels } : { _unit: "pixelsUnit", _value: pixels };
  return desc;
}

async function refine_edge(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  const layer = requireLayer(d, args.layer);
  const c = args.contract_px;
  const f = args.feather_px;
  if (!isNum(c) || c < 0 || !isNum(f) || f < 0) throw invalidArgs("contract_px and feather_px must be numbers >= 0");
  return stepIn(ps, `Claude: refine_edge, contract ${c} feather ${f}`, d, async () => {
    const warnings = [];
    await bp(ps, [D.selectLayerById(layer.id)]);
    if (await hasUserMaskStrict(ps, d.id, layer.id)) await bp(ps, [deleteMask()]);
    const sel = [loadTransparency()];
    if (c > 0) sel.push(D.contract(c));
    if (f > 0) sel.push(D.feather(f));
    await bp(ps, sel);
    await bp(ps, [D.makeMaskFromSelection("reveal")]);
    try {
      d.selection.deselect();
    } catch {
      // nothing left selected is fine either way
    }
    const result = { ok: true, warnings };
    if (args.decontaminate) {
      const defringe = recordedDefringe(1);
      if (!defringe) {
        warnings.push("defringe not recorded; skipped");
      } else {
        const dup = await layer.duplicate();
        dup.name = `${layer.name} decontaminated`;
        await bp(ps, [D.selectLayerById(dup.id), defringe]);
        layer.visible = false;
        result.decontaminated_layer_id = dup.id;
      }
    }
    return result;
  });
}

// ---------- match_tone ----------

// Mean RGB over pixels with alpha > 0 (all pixels when there is no alpha).
// Returns null when no pixel is opaque.
function meanRgbOpaque(data, components, count) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < count; i++) {
    const o = i * components;
    if (components === 4 && data[o + 3] === 0) continue;
    r += data[o];
    g += data[o + 1];
    b += data[o + 2];
    n++;
  }
  return n ? { r: r / n, g: g / n, b: b / n } : null;
}

const lum = (m) => 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;
const sat = (m) => {
  const max = Math.max(m.r, m.g, m.b);
  return max === 0 ? 0 : (max - Math.min(m.r, m.g, m.b)) / max;
};

async function readImage(ps, opts, read) {
  const { imageData } = await ps.imaging.getPixels(opts);
  try {
    return await read(imageData);
  } finally {
    imageData.dispose();
  }
}

async function match_tone(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  const layer = requireLayer(d, args.layer);
  if (!validBbox(args.reference_bbox)) throw codedError("INVALID_BBOX", "reference_bbox needs numeric left < right and top < bottom");
  const w = Number(d.width);
  const h = Number(d.height);
  const ref = clampBbox(args.reference_bbox, w, h);
  const own = clampBbox(norm(layer.bounds), w, h);

  const { layerMean, refMean } = await runRead(ps, "Match Tone Stats", async () => {
    const layerMean = await readImage(
      ps,
      {
        documentID: d.id,
        layerID: layer.id,
        sourceBounds: own,
        targetSize: { width: Math.min(256, own.right - own.left) },
        componentSize: 8,
        applyAlpha: false,
      },
      async (img) => meanRgbOpaque(await img.getData({ chunky: true }), img.components, img.width * img.height),
    );
    const refMean = await readImage(
      ps,
      { documentID: d.id, sourceBounds: ref, componentSize: 8, applyAlpha: true },
      async (img) => meanRgbOpaque(await img.getData({ chunky: true }), img.components, img.width * img.height),
    );
    if (!layerMean) throw codedError("EMPTY_LAYER", `Layer ${layer.id} has no visible pixels to measure`);
    if (!refMean) throw codedError("EMPTY_REGION", "reference_bbox has no visible pixels to measure");
    return { layerMean, refMean };
  });

  const dl = lum(refMean) - lum(layerMean);
  const lightness = clamp(Math.round(dl / 2.55), -40, 40);
  const saturation = clamp(Math.round((sat(refMean) - sat(layerMean)) * 100), -40, 40);
  const hue = 0;
  const curve = [[0, 0], [128, clamp(Math.round(128 + dl / 4), 0, 255)], [255, 255]];

  return stepIn(ps, `Claude: match_tone, L ${lightness} S ${saturation}`, d, async () => {
    // Each adjustment is made with the target selected, so it lands directly
    // above it, then clipped to it. A layer made inside an existing clipping
    // group is already clipped, and clipping it again would fail.
    const addClipped = async (descs) => {
      await bp(ps, [D.selectLayerById(layer.id)]);
      await bp(ps, descs);
      const id = activeId(d);
      let clipped = false;
      try {
        clipped = !!findLayer(d, id).isClippingMask;
      } catch {}
      if (!clipped) await bp(ps, [D.selectLayerById(id), D.clipToBelow()]);
      return id;
    };
    const hueSat = await addClipped(D.makeAdjustment("hue_sat", { hue, saturation, lightness }, "Match tone (HSL)"));
    const curves = await addClipped(D.makeAdjustment("curves", { points: { rgb: curve } }, "Match tone (curve)"));
    return { hue, saturation, lightness, curve, layer_ids: { hue_sat: hueSat, curves } };
  });
}

// ---------- blur_layer ----------

async function blur_layer(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  const layer = requireLayer(d, args.layer);
  const r = args.radius_px;
  if (!isNum(r) || r < 0.1 || r > 250) throw invalidArgs("radius_px must be a number from 0.1 to 250");
  return stepIn(ps, `Claude: blur_layer, ${r} px`, d, async () => {
    // A smart object takes the blur as an editable smart filter; an existing
    // one is not wrapped again.
    const descs = [D.selectLayerById(layer.id)];
    if (layer.kind !== "smartObject") descs.push(D.newPlacedLayer());
    descs.push(D.gaussianBlur(r));
    await bp(ps, descs);
    return { ok: true, smart_object: true, layer_id: activeId(d) };
  });
}

module.exports = { select_object, copy_to, refine_edge, match_tone, blur_layer, setRecorded };
