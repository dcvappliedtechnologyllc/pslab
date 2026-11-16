// DRAFT, NOT RECORDED ({draft: true}). The B0 recording pass could not reach the
// canvas (background control), so this is the researcher's `make contentLayer`
// draft (descriptor-drafts.md item 3, confidence MED-HIGH). add_shape tries it
// and falls back to a raster fill (vector: false) when Photoshop refuses it.
// Replace with a live recording (Rectangle tool, Shape mode, click for the
// numeric dialog, fill colour, no stroke) and drop `draft` once verified.
// Fields: the bbox edges in pixels and the fill colour (green is "grain").
const px = (v) => ({ _unit: "pixelsUnit", _value: v });
const rgb = () => ({ _obj: "RGBColor", red: 0, grain: 0, blue: 0 });

module.exports = {
  draft: true,
  make: {
    _obj: "make",
    _target: [{ _ref: "contentLayer" }],
    using: {
      _obj: "contentLayer",
      type: { _obj: "solidColorLayer", color: rgb() },
      shape: {
        _obj: "rectangle",
        unitValueQuadVersion: 1,
        top: px(0),
        left: px(0),
        bottom: px(0),
        right: px(0),
        topRight: px(0),
        topLeft: px(0),
        bottomLeft: px(0),
        bottomRight: px(0),
      },
      strokeStyle: {
        _obj: "strokeStyle",
        strokeStyleVersion: 2,
        strokeEnabled: false,
        fillEnabled: true,
        strokeStyleLineWidth: px(1),
        strokeStyleLineDashOffset: { _unit: "pointsUnit", _value: 0 },
        strokeStyleMiterLimit: 100,
        strokeStyleLineCapType: { _enum: "strokeStyleLineCapType", _value: "strokeStyleButtCap" },
        strokeStyleLineJoinType: { _enum: "strokeStyleLineJoinType", _value: "strokeStyleMiterJoin" },
        strokeStyleLineAlignment: { _enum: "strokeStyleLineAlignment", _value: "strokeStyleAlignInside" },
        strokeStyleScaleLock: false,
        strokeStyleStrokeAdjust: false,
        strokeStyleLineDashSet: [],
        strokeStyleBlendMode: { _enum: "blendMode", _value: "normal" },
        strokeStyleOpacity: { _unit: "percentUnit", _value: 100 },
        strokeStyleContent: { _obj: "solidColorLayer", color: rgb() },
        strokeStyleResolution: 72,
      },
    },
  },
  fields: {
    top: "make.using.shape.top",
    left: "make.using.shape.left",
    bottom: "make.using.shape.bottom",
    right: "make.using.shape.right",
    color_r: "make.using.type.color.red",
    color_g: "make.using.type.color.grain",
    color_b: "make.using.type.color.blue",
  },
};
