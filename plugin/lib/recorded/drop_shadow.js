// Recorded in Photoshop 27.11 on 2026-11-16 via dev_events (Layer > Layer
// Style > Drop Shadow: opacity 40, angle 120 with Use Global Light off,
// distance 6, spread 10, size 12). Format {set, fields}: an edit of the
// targeted layer, no make. Spread is recorded as chokeMatte in pixelsUnit
// holding the dialog's Spread value. scale follows the document resolution:
// 100 * ppi / 72 (486.11 on a 350 ppi doc); callers pass it, or reuse the
// scale from an existing `get layerEffects`. Setting layerEffects replaces the
// whole effect set, so callers merge the current effects in first.
module.exports = {
  set: {
    _obj: "set",
    _target: [
      { _ref: "property", _property: "layerEffects" },
      { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
    ],
    to: {
      _obj: "layerEffects",
      scale: { _unit: "percentUnit", _value: 486.1111111111111 },
      dropShadow: {
        _obj: "dropShadow",
        enabled: true,
        present: true,
        showInDialog: true,
        mode: { _enum: "blendMode", _value: "multiply" },
        color: { _obj: "RGBColor", red: 0, grain: 0, blue: 0 },
        opacity: { _unit: "percentUnit", _value: 40 },
        useGlobalAngle: false,
        localLightingAngle: { _unit: "angleUnit", _value: 120 },
        distance: { _unit: "pixelsUnit", _value: 6 },
        chokeMatte: { _unit: "pixelsUnit", _value: 10 },
        blur: { _unit: "pixelsUnit", _value: 12 },
        noise: { _unit: "percentUnit", _value: 0 },
        antiAlias: false,
        transferSpec: { _obj: "shapeCurveType", name: "Linear" },
        layerConceals: true,
      },
    },
  },
  fields: {
    scale: "set.to.scale",
    opacity: "set.to.dropShadow.opacity",
    angle: "set.to.dropShadow.localLightingAngle",
    distance_px: "set.to.dropShadow.distance",
    spread_pct: "set.to.dropShadow.chokeMatte",
    size_px: "set.to.dropShadow.blur",
    color_r: "set.to.dropShadow.color.red",
    color_g: "set.to.dropShadow.color.grain",
    color_b: "set.to.dropShadow.color.blue",
  },
};
