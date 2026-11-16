// Layer arrangement: select, reorder, move, transform and align existing
// layers. Validation runs before any modal call, so a rejected call leaves no
// history state; each change is one named step (stepIn).
const D = require("../descriptors");
const { runRead, bp } = require("../step");
const { findLayer, resolveDoc, safe } = require("../doc");
const { codedError, requireLayer } = require("./edit");

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

module.exports = { select_layer };
