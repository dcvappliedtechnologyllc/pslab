// Recorded in Photoshop 27.11.0 on 2026-11-01 via dev_events + a `get` of the
// layer's `adjustment` property. "Color and vibrance" is the vibrance layer
// with temperature and tint added.
module.exports = {
  make: {
    _obj: "make",
    _target: [{ _ref: "adjustmentLayer" }],
    using: { _obj: "adjustmentLayer", type: { _obj: "vibrance", useLegacy: false } },
  },
  set: {
    _obj: "set",
    _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
    to: { _obj: "vibrance", temperature: 0, tint: 0, vibrance: 0, saturation: 0, useLegacy: false },
  },
  fields: {
    temperature: "set.to.temperature",
    tint: "set.to.tint",
    vibrance: "set.to.vibrance",
    saturation: "set.to.saturation",
  },
};
