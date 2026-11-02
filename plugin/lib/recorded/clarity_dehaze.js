// Recorded in Photoshop 27.11.0 on 2026-11-01 via dev_events + a `get` of the
// layer's `adjustment` property.
module.exports = {
  make: {
    _obj: "make",
    _target: [{ _ref: "adjustmentLayer" }],
    using: { _obj: "adjustmentLayer", type: { _class: "clarity" } },
  },
  set: {
    _obj: "set",
    _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
    to: { _obj: "clarity", clarity: 0, dehaze: 0 },
  },
  fields: {
    clarity: "set.to.clarity",
    dehaze: "set.to.dehaze",
  },
};
