// Recorded in Photoshop 27.11 on 2026-11-16 via dev_events (double-click
// "Gaussian Blur" under Smart Filters, radius 4 -> 9, OK; history "Edit Filter
// Effect"). Format {set, fields}: an edit of the targeted layer, no make.
// _index is 1-based; 1 = the first applied (bottom) smart filter. Callers
// select the layer first and pass index and radius_px.
module.exports = {
  set: {
    _obj: "set",
    _target: [
      { _ref: "filterFX", _index: 1 },
      { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
    ],
    filterFX: {
      _obj: "filterFX",
      filter: { _obj: "gaussianBlur", radius: { _unit: "pixelsUnit", _value: 9 } },
    },
  },
  fields: {
    index: "set._target.0._index",
    radius_px: "set.filterFX.filter.radius",
  },
};
