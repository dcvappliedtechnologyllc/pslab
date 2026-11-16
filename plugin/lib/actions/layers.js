// Layer arrangement: select, reorder, move, transform and align existing
// layers. Validation runs before any modal call, so a rejected call leaves no
// history state; each change is one named step (stepIn).
const D = require("../descriptors");
const { runRead, bp } = require("../step");
const { findLayer, resolveDoc, safe } = require("../doc");
const { codedError, requireLayer, stepIn, isProtectedLayer } = require("./edit");
const { requireAnchor, placeAbove, placeBelow, isDirectlyAbove, isDirectlyBelow, locate } = require("../place");

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
  const modes = ["above", "below", "to"].filter((k) => given(args[k]));
  if (modes.length !== 1) throw invalid("Give exactly one of above, below or to");
  if (given(args.to)) {
    const top = Array.from(d.layers || []);
    if (args.to === "top") {
      const first = top[0];
      if (first.id === layer.id) return { plan: null };
      return { label: "to top", plan: () => layer.move(first, P.PLACEBEFORE) };
    }
    if (args.to === "bottom") {
      const bg = top.find((l) => safe(() => l.isBackgroundLayer, false) === true);
      if (bg) {
        if (isDirectlyAbove(d, layer, bg)) return { plan: null };
        return { label: "to bottom", plan: () => layer.move(bg, P.PLACEBEFORE) };
      }
      const last = top[top.length - 1];
      if (last.id === layer.id) return { plan: null };
      return { label: "to bottom", plan: () => layer.move(last, P.PLACEAFTER) };
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

module.exports = { select_layer, reorder_layer };
