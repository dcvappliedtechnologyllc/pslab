const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../lib/effects");

const pct = (v) => ({ _unit: "percentUnit", _value: v });
const px = (v) => ({ _unit: "pixelsUnit", _value: v });

test("mergeEffects keeps a stroke and an outer glow, replaces the drop shadow, keeps scale", () => {
  const existing = {
    _obj: "layerEffects",
    scale: pct(300),
    frameFX: { _obj: "frameFX", enabled: true, size: px(3) },
    outerGlow: { _obj: "outerGlow", enabled: true },
    dropShadow: { _obj: "dropShadow", opacity: pct(10) },
    dropShadowMulti: [{ _obj: "dropShadow" }, { _obj: "dropShadow" }],
  };
  const merged = E.mergeEffects(existing, "dropShadow", { _obj: "dropShadow", opacity: pct(60) });
  assert.deepEqual(merged, {
    _obj: "layerEffects",
    scale: pct(300),
    frameFX: { _obj: "frameFX", enabled: true, size: px(3) },
    outerGlow: { _obj: "outerGlow", enabled: true },
    dropShadow: { _obj: "dropShadow", opacity: pct(60) },
  });
  assert.equal(existing.dropShadow.opacity._value, 10, "input not mutated");
  assert.deepEqual(E.mergeEffects(null, "dropShadow", { _obj: "dropShadow" }), { _obj: "layerEffects", dropShadow: { _obj: "dropShadow" } });
  assert.deepEqual(E.mergeEffects(existing, "frameFX", null).frameFX, undefined, "null removes the effect");
});

test("effectKeys / hasEffects ignore the scale and switches", () => {
  assert.deepEqual(E.effectKeys({ _obj: "layerEffects", scale: pct(100), masterFXSwitch: true, frameFX: {} }), ["frameFX"]);
  assert.equal(E.hasEffects({ _obj: "layerEffects", scale: pct(100) }), false);
  assert.equal(E.hasEffects(null), false);
  assert.equal(E.hasEffects({ dropShadowMulti: [{}] }), true);
});

test("effectsScale is 100 * ppi / 72", () => {
  assert.ok(Math.abs(E.effectsScale(350) - 486.1111111111111) < 1e-9);
  assert.equal(E.effectsScale(72), 100);
  assert.equal(E.effectsScale(undefined), 100);
});

test("shadowParams fills the defaults under the given params", () => {
  assert.deepEqual(E.shadowParams({ opacity: 60, size_px: undefined }), {
    color: { r: 0, g: 0, b: 0 }, opacity: 60, angle: 120, distance_px: 6, spread_pct: 0, size_px: 10, blend: "multiply",
  });
});

test("validateShadowParams rejects unknown keys, out-of-range values and unknown blends", () => {
  for (const p of [{ glow: 1 }, { opacity: 101 }, { angle: 200 }, { size_px: -1 }, { blend: "dissolve" }, { color: { r: 0, g: 0 } }]) {
    assert.throws(() => E.validateShadowParams(p), { code: "INVALID_ARGS" }, JSON.stringify(p));
  }
  assert.doesNotThrow(() => E.validateShadowParams({ color: { r: 1, g: 2, b: 3 }, opacity: 0, angle: -180, blend: "soft_light" }));
});

test("shadowFromDescriptor reads a got dropShadow back into params", () => {
  const ds = {
    _obj: "dropShadow",
    mode: { _enum: "blendMode", _value: "linearBurn" },
    color: { _obj: "RGBColor", red: 10.2, grain: 20, blue: 29.8 },
    opacity: pct(40),
    localLightingAngle: { _unit: "angleUnit", _value: 90 },
    distance: px(6),
    chokeMatte: px(10),
    blur: px(12),
  };
  assert.deepEqual(E.shadowFromDescriptor(ds), {
    color: { r: 10, g: 20, b: 30 }, opacity: 40, angle: 90, distance_px: 6, spread_pct: 10, size_px: 12, blend: "linear_burn",
  });
  const hsb = E.shadowFromDescriptor({ color: { _obj: "HSBColorClass" }, mode: { _value: "dissolve" } });
  assert.equal(hsb.color, null);
  assert.equal(hsb.blend, "dissolve");
  assert.equal(E.blendValue("dissolve"), "dissolve");
  assert.equal(E.blendValue("soft_light"), "softLight");
});

test("flatShadow gives applyParams numbers, without colour fields when the colour is unknown", () => {
  const full = E.shadowParams({ color: { r: 1, g: 2, b: 3 } });
  assert.deepEqual(E.flatShadow(full, 200), { scale: 200, opacity: 35, angle: 120, distance_px: 6, spread_pct: 0, size_px: 10, color_r: 1, color_g: 2, color_b: 3 });
  assert.equal("color_r" in E.flatShadow({ ...full, color: null }, 100), false);
});
