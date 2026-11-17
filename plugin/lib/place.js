// Layer placement shared by every `above` argument (and reorder_layer).
// Validation helpers (requireAnchor) run before runStep; the rest run inside
// the caller's step. The DOM's layer.move is used for reordering: the
// batchPlay `move ... to ordinal` form failed live on Photoshop 27.11.
const D = require("./descriptors");
const { bp } = require("./step");
const { findLayer, safe } = require("./doc");

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const kids = (layer) => Array.from(safe(() => layer.layers, null) || []);

// {siblings, index, parents} for the layer with id, or null. parents lists the
// enclosing groups, innermost first.
function locate(d, id) {
  const walk = (list, parents) => {
    for (let i = 0; i < list.length; i++) {
      const layer = list[i];
      if (layer.id === id) return { siblings: list, index: i, parents };
      const sub = kids(layer);
      if (sub.length) {
        const found = walk(sub, [layer, ...parents]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(Array.from((d && d.layers) || []), []);
}

const isBackground = (layer) => safe(() => layer.isBackgroundLayer, false) === true;

// The anchor layer, or NO_LAYER. A layer inside a locked group is refused
// (PROTECTED_LAYER): nothing can be placed there.
function requireAnchor(d, id) {
  const layer = findLayer(d, id);
  if (!layer) throw codedError("NO_LAYER", `No layer with id ${id}`);
  const at = locate(d, id);
  const lockedParent = at && at.parents.find((p) => safe(() => p.allLocked, false) === true);
  if (lockedParent) {
    throw codedError(
      "PROTECTED_LAYER",
      `Layer ${id} is inside the locked group "${safe(() => lockedParent.name, "")}"; unlock it or pick another layer`,
    );
  }
  return layer;
}

// Select the anchor before a `make`, so the new layer is created directly above it.
function selectAnchor(ps, id) {
  return bp(ps, [D.selectLayerById(id)]);
}

// Same container: both top level, or both in the same group (by id; the DOM
// hands out fresh arrays and wrapper objects on every read).
function sameList(a, b) {
  const pa = a.parents[0];
  const pb = b.parents[0];
  return pa === undefined || pb === undefined ? pa === pb : pa.id === pb.id;
}

function isDirectlyAbove(d, layer, anchor) {
  const a = locate(d, layer.id);
  const b = locate(d, anchor.id);
  return !!(a && b && sameList(a, b) && a.index === b.index - 1);
}

function isDirectlyBelow(d, layer, anchor) {
  const a = locate(d, layer.id);
  const b = locate(d, anchor.id);
  return !!(a && b && sameList(a, b) && a.index === b.index + 1);
}

// Moved next to a clipped layer (or the base of a clipping group) a layer
// joins the clip; release it unless the caller asked for clipping.
function releaseClip(layer, clip) {
  if (!clip && safe(() => layer.isClippingMask, false) === true) layer.isClippingMask = false;
}

// Put `layer` directly above anchorId (inside the anchor's group, if any).
// Returns the layer (re-read by id when the DOM hands back a new object).
async function placeAbove(ps, d, layer, anchorId, { clip = false } = {}) {
  const anchor = findLayer(d, anchorId);
  if (!anchor) throw codedError("NO_LAYER", `No layer with id ${anchorId}`);
  if (anchor.id !== layer.id && !isDirectlyAbove(d, layer, anchor)) {
    await layer.move(anchor, ps.constants.ElementPlacement.PLACEBEFORE);
  }
  const placed = findLayer(d, layer.id) || layer;
  releaseClip(placed, clip);
  return placed;
}

// Put `layer` directly below anchorId; never below the Background.
async function placeBelow(ps, d, layer, anchorId, { clip = false } = {}) {
  const anchor = findLayer(d, anchorId);
  if (!anchor) throw codedError("NO_LAYER", `No layer with id ${anchorId}`);
  if (isBackground(anchor)) {
    throw codedError("PROTECTED_LAYER", "Nothing can go below the Background layer");
  }
  if (anchor.id !== layer.id && !isDirectlyBelow(d, layer, anchor)) {
    await layer.move(anchor, ps.constants.ElementPlacement.PLACEAFTER);
  }
  const placed = findLayer(d, layer.id) || layer;
  releaseClip(placed, clip);
  return placed;
}

module.exports = { requireAnchor, selectAnchor, placeAbove, placeBelow, isDirectlyAbove, isDirectlyBelow, locate, releaseClip };
