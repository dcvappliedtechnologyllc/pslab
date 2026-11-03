const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../lib/descriptors");

const LAYER_TARGET = [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }];
const px = (v) => ({ _unit: "pixelsUnit", _value: v });

test("selectLayerById", () => {
  assert.deepStrictEqual(d.selectLayerById(7), {
    _obj: "select", _target: [{ _ref: "layer", _id: 7 }], makeVisible: false,
  });
});

test("makeAdjustment curves: make then set", () => {
  const out = d.makeAdjustment("curves", { points: { rgb: [[0, 0], [128, 121], [255, 255]] } }, "Lift");
  assert.equal(out.length, 2);
  assert.deepStrictEqual(out[0], {
    _obj: "make", _target: [{ _ref: "adjustmentLayer" }],
    using: { _obj: "adjustmentLayer", name: "Lift",
      type: { _obj: "curves", presetKind: { _enum: "presetKindType", _value: "presetKindDefault" } } },
  });
  assert.deepStrictEqual(out[1], {
    _obj: "set",
    _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
    to: { _obj: "curves",
      presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
      adjustment: [{ _obj: "curvesAdjustment",
        channel: { _ref: "channel", _enum: "channel", _value: "composite" },
        curve: [
          { _obj: "paint", horizontal: 0, vertical: 0 },
          { _obj: "paint", horizontal: 128, vertical: 121 },
          { _obj: "paint", horizontal: 255, vertical: 255 },
        ] }] },
  });
});

test("makeAdjustment curves: per-channel, green is grain, default identity", () => {
  const out = d.makeAdjustment("curves", { points: { red: [[0, 0], [255, 255]], green: [[0, 10], [255, 255]], blue: [[0, 0], [255, 250]] } });
  const adj = out[1].to.adjustment;
  assert.deepStrictEqual(adj.map((a) => a.channel._value), ["red", "grain", "blue"]);
  assert.equal(out[0].using.name, undefined);
  const dflt = d.makeAdjustment("curves", {});
  assert.deepStrictEqual(dflt[1].to.adjustment[0].curve, [
    { _obj: "paint", horizontal: 0, vertical: 0 }, { _obj: "paint", horizontal: 255, vertical: 255 }]);
  assert.equal(dflt[1].to.adjustment[0].channel._value, "composite");
});

test("makeAdjustment hue_sat: make then set", () => {
  const out = d.makeAdjustment("hue_sat", { hue: 5, saturation: -10, lightness: 2 }, "HS");
  assert.deepStrictEqual(out, [
    { _obj: "make", _target: [{ _ref: "adjustmentLayer" }],
      using: { _obj: "adjustmentLayer", name: "HS",
        type: { _obj: "hueSaturation", presetKind: { _enum: "presetKindType", _value: "presetKindDefault" } } } },
    { _obj: "set",
      _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
      to: { _obj: "hueSaturation", adjustment: [{ _obj: "hueSatAdjustmentV2", hue: 5, saturation: -10, lightness: 2 }] } },
  ]);
  const z = d.makeAdjustment("hue_sat", undefined, "x");
  assert.deepStrictEqual(z[1].to.adjustment[0], { _obj: "hueSatAdjustmentV2", hue: 0, saturation: 0, lightness: 0 });
});

test("makeAdjustment exposure / brightness_contrast / vibrance: values in make", () => {
  assert.deepStrictEqual(d.makeAdjustment("exposure", { exposure: 0.5, offset: 0.1, gamma: 1.2 }, "E"), [
    { _obj: "make", _target: [{ _ref: "adjustmentLayer" }],
      using: { _obj: "adjustmentLayer", name: "E",
        type: { _obj: "exposure", exposure: 0.5, offset: 0.1, gammaCorrection: 1.2 } } }]);
  assert.deepStrictEqual(d.makeAdjustment("brightness_contrast", { brightness: 10, contrast: 5 }, "B")[0].using.type,
    { _obj: "brightnessEvent", brightness: 10, center: 5, useLegacy: false });
  assert.deepStrictEqual(d.makeAdjustment("vibrance", { vibrance: 20, saturation: -3 }, "V")[0].using.type,
    { _obj: "vibrance", vibrance: 20, saturation: -3 });
  assert.deepStrictEqual(d.makeAdjustment("vibrance", {}, "V")[0].using.type,
    { _obj: "vibrance", vibrance: 0, saturation: 0 });
  assert.equal(d.makeAdjustment("exposure", {}, "E")[0].using.type.gammaCorrection, 1);
});

test("makeAdjustment unknown type throws NOT_SUPPORTED", () => {
  assert.throws(() => d.makeAdjustment("light", {}, "x"), (e) => e instanceof Error && e.code === "NOT_SUPPORTED");
});

test("clip, masks, invert, feather", () => {
  assert.deepStrictEqual(d.clipToBelow(), { _obj: "groupEvent", _target: LAYER_TARGET });
  assert.deepStrictEqual(d.makeMaskFromSelection("reveal"), {
    _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" },
    using: { _enum: "userMaskEnabled", _value: "revealSelection" } });
  assert.equal(d.makeMaskFromSelection("hide").using._value, "hideSelection");
  assert.deepStrictEqual(d.selectMaskChannel(), {
    _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }], makeVisible: false });
  assert.deepStrictEqual(d.selectRgbChannel(), {
    _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "RGB" }], makeVisible: false });
  assert.deepStrictEqual(d.invert(), { _obj: "invert" });
  assert.deepStrictEqual(d.setMaskFeather(25.5), {
    _obj: "set", _target: LAYER_TARGET, to: { _obj: "layer", userMaskFeather: px(25.5) } });
});

test("selections", () => {
  assert.deepStrictEqual(d.selectRectangle({ left: 1, top: 2, right: 30, bottom: 40 }), {
    _obj: "set", _target: [{ _ref: "channel", _property: "selection" }],
    to: { _obj: "rectangle", top: px(2), left: px(1), bottom: px(40), right: px(30) } });
  const pts = [{ x: 1, y: 2 }, { x: 5, y: 6 }, { x: 9, y: 1 }];
  const poly = {
    _obj: "set", _target: [{ _ref: "channel", _property: "selection" }],
    to: { _obj: "polygon", points: [
      { _obj: "paint", horizontal: px(1), vertical: px(2) },
      { _obj: "paint", horizontal: px(5), vertical: px(6) },
      { _obj: "paint", horizontal: px(9), vertical: px(1) }] } };
  assert.deepStrictEqual(d.selectPolygon(pts), poly);
  const extra = { deepSelect: true, objectSelectionMode: 0, magicLassoAutoEnhance: true, smartSubtract: true };
  assert.deepStrictEqual(d.objectSelect(pts), { ...poly, ...extra });
  const bbox = { left: 1, top: 2, right: 30, bottom: 40 };
  assert.deepStrictEqual(d.objectSelect(bbox), { ...d.selectRectangle(bbox), ...extra });
  assert.deepStrictEqual(d.selectSubject(), { _obj: "autoCutout", sampleAllLayers: false });
  assert.deepStrictEqual(d.contract(3), { _obj: "contract", by: px(3), selectionModifyEffectAtCanvasBounds: false });
  assert.deepStrictEqual(d.feather(4), { _obj: "feather", radius: px(4), selectionModifyEffectAtCanvasBounds: false });
});

test("fill", () => {
  assert.deepStrictEqual(d.fill("white", 70), {
    _obj: "fill", using: { _enum: "fillContents", _value: "white" },
    opacity: { _unit: "percentUnit", _value: 70 }, mode: { _enum: "blendMode", _value: "normal" } });
  assert.equal(d.fill("black", 100).using._value, "black");
});

test("transform", () => {
  assert.deepStrictEqual(d.transform({ scalePct: 50, dx: 10, dy: -4 }), {
    _obj: "transform", _target: LAYER_TARGET,
    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
    width: { _unit: "percentUnit", _value: 50 }, height: { _unit: "percentUnit", _value: 50 }, linked: true,
    angle: { _unit: "angleUnit", _value: 0 },
    offset: { _obj: "offset", horizontal: px(10), vertical: px(-4) },
    interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubic" } });
  const t = d.transform({ scalePct: 100 });
  assert.deepStrictEqual(t.offset, { _obj: "offset", horizontal: px(0), vertical: px(0) });
});

test("transform with angleDeg rotates; default angle stays 0", () => {
  const t = d.transform({ scalePct: 100, angleDeg: -2.5 });
  assert.deepStrictEqual(t.angle, { _unit: "angleUnit", _value: -2.5 });
  assert.deepStrictEqual(t.width, { _unit: "percentUnit", _value: 100 });
  assert.deepStrictEqual(t.height, { _unit: "percentUnit", _value: 100 });
  assert.deepStrictEqual(d.transform({ scalePct: 80 }).angle, { _unit: "angleUnit", _value: 0 });
});

test("geometry and cleanup descriptors", () => {
  assert.deepStrictEqual(d.stampVisible(), { _obj: "mergeVisible", duplicate: true });
  assert.deepStrictEqual(d.contentAwareFill(), {
    _obj: "fill", using: { _enum: "fillContents", _value: "contentAware" },
    contentAwareColorAdaptationFill: true, contentAwareRotationFill: false,
    contentAwareScaleFill: false, contentAwareMirrorFill: false,
    opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } });
  assert.deepStrictEqual(d.expand(2), { _obj: "expand", by: px(2), selectionModifyEffectAtCanvasBounds: false });
  assert.deepStrictEqual(d.inverseSelection(), { _obj: "inverse" });
  assert.deepStrictEqual(d.clearSelected(), { _obj: "delete" });
  assert.deepStrictEqual(d.deselect(), {
    _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } });
});

test("profile, save, smart object, filters", () => {
  assert.deepStrictEqual(d.convertToSRGB(), {
    _obj: "convertToProfile", _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
    to: "sRGB IEC61966-2.1", intent: { _enum: "intent", _value: "colorimetric" },
    mapBlack: true, dither: true, flatten: false, rasterizePlaced: false, shadowMode: -1 });
  assert.deepStrictEqual(d.saveJpeg("tok", 10), {
    _obj: "save", as: { _obj: "JPEG", extendedQuality: 10, matteColor: { _enum: "matteColor", _value: "white" } },
    in: { _kind: "local", _path: "tok" }, copy: true, lowerCase: true });
  assert.deepStrictEqual(d.newPlacedLayer(), { _obj: "newPlacedLayer" });
  assert.deepStrictEqual(d.gaussianBlur(2.5), { _obj: "gaussianBlur", radius: px(2.5) });
  assert.deepStrictEqual(d.defringe(1), { _obj: "defringe", width: px(1) });
});

test("duplicateLayerTo", () => {
  assert.deepStrictEqual(d.duplicateLayerTo(12, "Copy"), {
    _obj: "duplicate", _target: LAYER_TARGET, to: { _ref: "document", _id: 12 }, name: "Copy" });
  assert.equal("name" in d.duplicateLayerTo(12), false);
});

test("builders return fresh objects", () => {
  assert.notStrictEqual(d.invert(), d.invert());
  assert.notStrictEqual(d.clipToBelow()._target, d.clipToBelow()._target);
  const a = d.makeAdjustment("vibrance", {}, "x");
  const b = d.makeAdjustment("vibrance", {}, "x");
  assert.notStrictEqual(a[0], b[0]);
  a[0].using.type.vibrance = 99;
  assert.equal(b[0].using.type.vibrance, 0);
});

test("recorded map lists every type and is null for a module that is not there", () => {
  const recorded = require("../lib/recorded");
  assert.deepEqual(Object.keys(recorded).sort(), ["clarity_dehaze", "color_vibrance", "defringe", "gaussian_blur", "light"]);
  const fs = require("node:fs");
  const path = require("node:path");
  for (const [type, value] of Object.entries(recorded)) {
    const exists = fs.existsSync(path.join(__dirname, "../lib/recorded", `${type}.js`));
    if (!exists) assert.equal(value, null, type);
  }
});

test("setAdjustment: set on the targeted adjustment layer with the make payloads", () => {
  const adjTarget = [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }];
  const ch = (v) => ({ _ref: "channel", _enum: "channel", _value: v });
  const paint = (pts) => pts.map(([x, y]) => ({ _obj: "paint", horizontal: x, vertical: y }));
  const id = paint([[0, 0], [255, 255]]);
  const points = { rgb: [[0, 0], [128, 121], [255, 255]], blue: [[0, 0], [255, 250]] };
  // curves set always carries all four channels, identity for those left out
  assert.deepStrictEqual(d.setAdjustment("curves", { points }), {
    _obj: "set", _target: adjTarget,
    to: { _obj: "curves", presetKind: { _enum: "presetKindType", _value: "presetKindCustom" }, adjustment: [
      { _obj: "curvesAdjustment", channel: ch("composite"), curve: paint(points.rgb) },
      { _obj: "curvesAdjustment", channel: ch("red"), curve: id },
      { _obj: "curvesAdjustment", channel: ch("grain"), curve: id },
      { _obj: "curvesAdjustment", channel: ch("blue"), curve: paint(points.blue) },
    ] },
  });
  assert.equal(d.setAdjustment("curves", {}).to.adjustment.length, 4);
  // make keeps only the channels given
  assert.equal(d.makeAdjustment("curves", { points })[1].to.adjustment.length, 2);
  assert.deepStrictEqual(d.setAdjustment("hue_sat", { hue: 5 }), d.makeAdjustment("hue_sat", { hue: 5 })[1]);
  assert.deepStrictEqual(d.setAdjustment("exposure", { exposure: 0.5, offset: 0.1, gamma: 1.2 }), {
    _obj: "set", _target: adjTarget,
    to: { _obj: "exposure", presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
      exposure: 0.5, offset: 0.1, gammaCorrection: 1.2 },
  });
  assert.equal("presetKind" in d.makeAdjustment("exposure", {})[0].using.type, false);
  assert.deepStrictEqual(d.setAdjustment("brightness_contrast", { brightness: 10, contrast: 5 }), {
    _obj: "set", _target: adjTarget,
    to: { _obj: "brightnessEvent", brightness: 10, center: 5, useLegacy: false },
  });
  assert.throws(() => d.setAdjustment("light", {}), (e) => e.code === "NOT_SUPPORTED");
});

test("makeAdjustment levels: default-preset make, then a custom set per channel (green is grain)", () => {
  const out = d.makeAdjustment("levels", {
    rgb: { in_black: 4, in_white: 240, gamma: 1.2 },
    green: { in_white: 231 },
    blue: { in_white: 224, out_black: 3, out_white: 250 },
  });
  assert.deepStrictEqual(out, [
    { _obj: "make", _target: [{ _ref: "adjustmentLayer" }],
      using: { _obj: "adjustmentLayer",
        type: { _obj: "levels", presetKind: { _enum: "presetKindType", _value: "presetKindDefault" } } } },
    { _obj: "set", _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
      to: { _obj: "levels", presetKind: { _enum: "presetKindType", _value: "presetKindCustom" }, adjustment: [
        { _obj: "levelsAdjustment", channel: { _ref: "channel", _enum: "channel", _value: "composite" },
          input: [4, 240], gamma: 1.2, output: [0, 255] },
        { _obj: "levelsAdjustment", channel: { _ref: "channel", _enum: "channel", _value: "grain" },
          input: [0, 231], gamma: 1, output: [0, 255] },
        { _obj: "levelsAdjustment", channel: { _ref: "channel", _enum: "channel", _value: "blue" },
          input: [0, 224], gamma: 1, output: [3, 250] },
      ] } },
  ]);
  // set always carries all four channels, identity for those left out
  const lv = (v, input = [0, 255]) => ({ _obj: "levelsAdjustment", channel: { _ref: "channel", _enum: "channel", _value: v },
    input, gamma: 1, output: [0, 255] });
  assert.deepStrictEqual(d.setAdjustment("levels", { red: { in_white: 250 } }), {
    _obj: "set", _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
    to: { _obj: "levels", presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
      adjustment: [lv("composite"), lv("red", [0, 250]), lv("grain"), lv("blue")] },
  });
  assert.deepStrictEqual(d.setAdjustment("levels", {}).to.adjustment, [lv("composite"), lv("red"), lv("grain"), lv("blue")]);
  // make keeps only the channels given, identity composite when none
  assert.deepStrictEqual(d.makeAdjustment("levels", {})[1].to.adjustment, [lv("composite")]);
  assert.equal(d.makeAdjustment("levels", {}, "WB")[0].using.name, "WB");
});
