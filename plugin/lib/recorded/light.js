// Recorded in Photoshop 27.11.0 on 2026-11-01 via dev_events + a `get` of the
// layer's `adjustment` property. The Light layer is a brightnessEvent in
// brightnessModeLight; contrast lives in `center`.
module.exports = {
  make: {
    _obj: "make",
    _target: [{ _ref: "adjustmentLayer" }],
    using: {
      _obj: "adjustmentLayer",
      type: {
        _obj: "brightnessEvent",
        brightnessMode: { _enum: "brightnessModeType", _value: "brightnessModeLight" },
        useLegacy: false,
      },
    },
  },
  set: {
    _obj: "set",
    _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
    to: {
      _obj: "brightnessEvent",
      brightnessMode: { _enum: "brightnessModeType", _value: "brightnessModeLight" },
      brightnessExposure: 0,
      center: 0,
      brightnessHighlights: 0,
      brightnessShadows: 0,
      brightnessWhites: 0,
      brightnessBlacks: 0,
      useLegacy: false,
    },
  },
  fields: {
    exposure: "set.to.brightnessExposure",
    contrast: "set.to.center",
    highlights: "set.to.brightnessHighlights",
    shadows: "set.to.brightnessShadows",
    whites: "set.to.brightnessWhites",
    blacks: "set.to.brightnessBlacks",
  },
};
