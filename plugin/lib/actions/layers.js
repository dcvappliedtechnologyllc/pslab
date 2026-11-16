// Layer arrangement: select, reorder, move, transform and align existing
// layers. Validation runs before any modal call, so a rejected call leaves no
// history state; each change is one named step (stepIn).
const D = require("../descriptors");
const { runRead, bp } = require("../step");
const { findLayer, resolveDoc, safe, layerBounds, normBounds } = require("../doc");
const { unionBounds, moveDelta, transformDelta, alignDeltas } = require("../layout");
const { codedError, requireLayer, stepIn, isProtectedLayer } = require("./edit");
const { requireAnchor, placeAbove, placeBelow, isDirectlyAbove, isDirectlyBelow, locate, releaseClip } = require("../place");

const invalid = (message) => codedError("INVALID_ARGS", message);

// A list of 1..max distinct layer ids that all exist in d.
function requireLayerList(d, ids, max, key = "layers") {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > max) {
    throw invalid(`${key} must list 1 to ${max} layer ids`);
  }
  if (new Set(ids).size !== ids.length) throw invalid(`${key} lists the same id twice`);
  return ids.map((id) => requireLayer(d, id));
}

async function activate(ps, d) {
  const active = ps.app.activeDocument;
  if (!active || active.id !== d.id) ps.app.activeDocument = d;
}

const activeIds = (d) => Array.from(safe(() => d.activeLayers, null) || []).map((l) => l.id);

// ---------- select_layer ----------

const addToSelection = (id) => ({
  _obj: "select",
  _target: [{ _ref: "layer", _id: id }],
  selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" },
  makeVisible: false,
});

// Selection is not a document change: no history state. doc stays active
// afterwards, so a following copy_to or copy_layers_to acts on it.
async function select_layer(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  const list = requireLayerList(d, args.layers, 50);
  return runRead(ps, "pslab: select_layer", async () => {
    await activate(ps, d);
    await bp(ps, [D.selectLayerById(list[0].id)]);
    for (const layer of list.slice(1)) {
      try {
        await bp(ps, [addToSelection(layer.id)]);
      } catch {
        layer.selected = true; // DOM fallback
      }
    }
    return { active_layer_ids: activeIds(d) };
  });
}

// ---------- reorder_layer ----------

const nameOf = (layer) => String(safe(() => layer.name, ""));
const given = (v) => v !== undefined && v !== null;

function requireMovable(d, id) {
  const layer = requireLayer(d, id);
  if (isProtectedLayer(layer)) {
    throw codedError("PROTECTED_LAYER", `Layer ${id} (${nameOf(layer)}) is the Background layer and does not move`);
  }
  return layer;
}

// {plan, label} for reorder_layer, or {plan: null} when already in place.
// plan(ps) runs inside the step. DOM layer.move only: the batchPlay
// `move ... to ordinal` form failed live on Photoshop 27.11.
function reorderPlan(ps, d, layer, args) {
  const P = ps.constants.ElementPlacement;
  // to top/bottom: a layer landing above a clipped one joins the clip; release
  // it, as placeAbove/placeBelow do for above/below.
  const moveTo = (rel, placement) => async () => {
    await layer.move(rel, placement);
    releaseClip(findLayer(d, layer.id) || layer, false);
  };
  const modes = ["above", "below", "to"].filter((k) => given(args[k]));
  if (modes.length !== 1) throw invalid("Give exactly one of above, below or to");
  if (given(args.to)) {
    const top = Array.from(d.layers || []);
    if (args.to === "top") {
      const first = top[0];
      if (first.id === layer.id) return { plan: null };
      return { label: "to top", plan: moveTo(first, P.PLACEBEFORE) };
    }
    if (args.to === "bottom") {
      const bg = top.find((l) => safe(() => l.isBackgroundLayer, false) === true);
      if (bg) {
        if (isDirectlyAbove(d, layer, bg)) return { plan: null };
        return { label: "to bottom", plan: moveTo(bg, P.PLACEBEFORE) };
      }
      const last = top[top.length - 1];
      if (last.id === layer.id) return { plan: null };
      return { label: "to bottom", plan: moveTo(last, P.PLACEAFTER) };
    }
    throw invalid(`to must be top or bottom, got ${args.to}`);
  }
  const where = given(args.above) ? "above" : "below";
  const anchor = requireAnchor(d, args[where]);
  if (anchor.id === layer.id) throw invalid(`A layer cannot go ${where} itself`);
  const at = locate(d, anchor.id);
  if (at && at.parents.some((p) => p.id === layer.id)) {
    throw invalid(`Layer ${anchor.id} is inside group ${layer.id}; a group cannot go ${where} its own contents`);
  }
  if (where === "below" && isProtectedLayer(anchor)) {
    throw codedError("PROTECTED_LAYER", "Nothing can go below the Background layer");
  }
  const inPlace = where === "above" ? isDirectlyAbove(d, layer, anchor) : isDirectlyBelow(d, layer, anchor);
  if (inPlace) return { plan: null };
  const place = where === "above" ? placeAbove : placeBelow;
  return { label: `${where} ${nameOf(anchor)}`, plan: () => place(ps, d, layer, anchor.id) };
}

const indexOf = (d, id) => {
  const at = locate(d, id);
  return at ? at.index : null;
};

async function reorder_layer(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  const layer = requireMovable(d, args.layer);
  const { plan, label } = reorderPlan(ps, d, layer, args);
  if (!plan) return { layer_id: layer.id, index: indexOf(d, layer.id), moved: false };
  return stepIn(ps, `Claude: reorder_layer, ${nameOf(layer)} ${label}`, d, async () => {
    await plan();
    return { layer_id: layer.id, index: indexOf(d, layer.id), moved: true };
  });
}

// ---------- move_layer ----------

const plural = (n) => `${n} layer${n === 1 ? "" : "s"}`;
const has = (v) => typeof v === "number" && Number.isFinite(v);

// The layers a move or align acts on: listed, existing, distinct, never the
// Background; a layer whose group is also listed moves with the group, so it
// is dropped. Layers without pixels (empty, or an adjustment without a mask)
// have no bounds and are reported in skipped.
function moveTargets(d, ids) {
  const list = requireLayerList(d, ids, 50);
  for (const layer of list) requireMovable(d, layer.id);
  const listed = new Set(ids);
  const own = list.filter((layer) => {
    const at = locate(d, layer.id);
    return !(at && at.parents.some((p) => listed.has(p.id)));
  });
  const live = [];
  const skipped = [];
  for (const layer of own) {
    const bounds = layerBounds(layer);
    if (bounds) live.push({ layer, bounds });
    else skipped.push({ id: layer.id, name: nameOf(layer) });
  }
  return { live, skipped };
}

// DOM translate; fallback: a pure-offset Free Transform (live-verified in clone_from).
async function translateLayer(ps, layer, dx, dy) {
  if (dx === 0 && dy === 0) return;
  try {
    await layer.translate(dx, dy);
  } catch {
    await bp(ps, [D.selectLayerById(layer.id), D.transform({ scalePct: 100, dx, dy })]);
  }
}

const boundsNow = (d, layer) => layerBounds(findLayer(d, layer.id) || layer);

async function move_layer(ps, args = {}) {
  const rel = has(args.dx) || has(args.dy);
  const abs = has(args.x) || has(args.y);
  if (!rel && !abs) throw invalid("Give dx/dy (relative) or x/y (absolute)");
  if (rel && abs) throw invalid("Give either dx/dy (relative) or x/y (absolute), not both");
  const { d } = resolveDoc(ps, args.doc);
  const { live, skipped } = moveTargets(d, args.layers);
  if (live.length === 0) return { moved: [], dx: 0, dy: 0, skipped };
  const { dx, dy } = moveDelta(unionBounds(live.map((t) => t.bounds)), args);
  const report = () => live.map(({ layer }) => ({ id: layer.id, bounds: boundsNow(d, layer) }));
  if (dx === 0 && dy === 0) return { moved: report(), dx, dy, skipped };
  return stepIn(ps, `Claude: move_layer, ${plural(live.length)} ${dx},${dy}`, d, async () => {
    for (const { layer } of live) await translateLayer(ps, layer, dx, dy);
    return { moved: report(), dx, dy, skipped };
  });
}

// ---------- transform_layer ----------

const fmt = (v) => String(Math.round(v * 10) / 10);

async function transform_layer(ps, args = {}) {
  const scale = args.scale_pct;
  const angle = args.rotate_deg;
  if (![scale, angle, args.cx, args.cy].some(has)) {
    throw invalid("Give at least one of scale_pct, rotate_deg, cx or cy");
  }
  if (has(scale) && !(scale >= 1 && scale <= 1000)) throw invalid(`scale_pct must be 1..1000, got ${scale}`);
  if (has(angle) && !(angle >= -180 && angle <= 180)) throw invalid(`rotate_deg must be -180..180, got ${angle}`);
  const { d } = resolveDoc(ps, args.doc);
  const layer = requireMovable(d, args.layer);
  const bounds = layerBounds(layer);
  if (!bounds) throw codedError("EMPTY_LAYER", `Layer ${layer.id} (${nameOf(layer)}) has no pixels to transform`);
  const { dx, dy, cx, cy } = transformDelta(bounds, args);
  const scalePct = has(scale) ? scale : 100;
  const angleDeg = has(angle) ? angle : 0;
  const name = `Claude: transform_layer, ${fmt(scalePct)}% ${fmt(angleDeg)}° @ ${fmt(cx)},${fmt(cy)}`;
  return stepIn(ps, name, d, async () => {
    await bp(ps, [D.selectLayerById(layer.id), D.transform({ scalePct, angleDeg, dx, dy })]);
    return { layer_id: layer.id, bounds: boundsNow(d, layer) };
  });
}

// ---------- align_layers ----------

const HORIZONTAL = ["left", "center", "right"];
const VERTICAL = ["top", "center", "bottom"];

// The box align_layers aligns to, and its label for the history name.
function alignTarget(d, args) {
  const to = args.to ?? "canvas";
  if (to === "canvas") {
    return { box: { left: 0, top: 0, right: Number(d.width), bottom: Number(d.height) }, label: "canvas" };
  }
  if (to === "selection") {
    const box = normBounds(safe(() => d.selection.bounds, null));
    if (!box) throw codedError("NO_SELECTION", "There is no active selection to align to");
    return { box, label: "selection" };
  }
  const layer = requireLayer(d, args.to_layer);
  const box = layerBounds(layer);
  if (!box) throw codedError("EMPTY_LAYER", `Layer ${layer.id} (${nameOf(layer)}) has no pixels to align to`);
  return { box, label: nameOf(layer) };
}

async function align_layers(ps, args = {}) {
  const { horizontal, vertical } = args;
  if (!given(horizontal) && !given(vertical)) throw invalid("Give horizontal and/or vertical");
  if (given(horizontal) && !HORIZONTAL.includes(horizontal)) throw invalid(`horizontal must be left, center or right, got ${horizontal}`);
  if (given(vertical) && !VERTICAL.includes(vertical)) throw invalid(`vertical must be top, center or bottom, got ${vertical}`);
  const to = args.to ?? "canvas";
  if (!["canvas", "selection", "layer"].includes(to)) throw invalid(`to must be canvas, selection or layer, got ${to}`);
  if ((to === "layer") !== given(args.to_layer)) throw invalid('Give to_layer exactly when to is "layer"');
  const { d } = resolveDoc(ps, args.doc);
  const { live, skipped } = moveTargets(d, args.layers);
  const { box, label } = alignTarget(d, args);
  const asGroup = args.as_group === true;
  const deltas = alignDeltas(live.map((t) => t.bounds), box, { horizontal, vertical }, asGroup);
  const report = () => live.map(({ layer }) => ({ id: layer.id, bounds: boundsNow(d, layer) }));
  if (deltas.every((m) => m.dx === 0 && m.dy === 0)) return { moved: report(), skipped };
  const how = [given(horizontal) && `h-${horizontal}`, given(vertical) && `v-${vertical}`].filter(Boolean).join(" ");
  const name = `Claude: align_layers, ${plural(live.length)} ${how} to ${label}${asGroup ? " as group" : ""}`;
  return stepIn(ps, name, d, async () => {
    for (let i = 0; i < live.length; i++) await translateLayer(ps, live[i].layer, deltas[i].dx, deltas[i].dy);
    return { moved: report(), skipped };
  });
}

module.exports = { select_layer, reorder_layer, move_layer, transform_layer, align_layers };
