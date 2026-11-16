// Recorded batchPlay descriptors, one CommonJS module per type next to this
// file (light.js, clarity_dehaze.js, color_vibrance.js, defringe.js,
// gaussian_blur.js, drop_shadow.js, clear_layer_style.js, edit_smart_filter.js, shape_rect.js, shape_ellipse.js), each `module.exports = {...}`. See README.md for the shapes.
// A missing module, or one that fails to load, is null; callers treat null and
// {unsupported: true} the same way (fallback path).

function load(read) {
  try {
    return read();
  } catch {
    return null;
  }
}

module.exports = {
  light: load(() => require("./light.js")),
  clarity_dehaze: load(() => require("./clarity_dehaze.js")),
  color_vibrance: load(() => require("./color_vibrance.js")),
  defringe: load(() => require("./defringe.js")),
  gaussian_blur: load(() => require("./gaussian_blur.js")),
  drop_shadow: load(() => require("./drop_shadow.js")),
  clear_layer_style: load(() => require("./clear_layer_style.js")),
  edit_smart_filter: load(() => require("./edit_smart_filter.js")),
  // drafts (not recorded live; marked draft: true)
  shape_rect: load(() => require("./shape_rect.js")),
  shape_ellipse: load(() => require("./shape_ellipse.js")),
};
