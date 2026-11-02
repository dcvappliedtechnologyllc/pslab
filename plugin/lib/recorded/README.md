# Recorded descriptors

One CommonJS module per type (`light.js`, `clarity_dehaze.js`, `color_vibrance.js`, `defringe.js`, `gaussian_blur.js`), written as `module.exports = {...}`, captured with the `dev_events` tool.

- Adjustment types (`light`, `clarity_dehaze`, `color_vibrance`): `{make, set?, fields}`. `make` (and the optional `set`) are batchPlay descriptors; `fields` maps each param name to a path such as `"make.using.type.exposure"` or `"set.to.contrast"`, and that value is replaced by the param (a `{_unit, _value}` keeps its unit).
- Filters (`defringe`, `gaussian_blur`): one batchPlay descriptor `{_obj, ...}`; the width or radius is set by the caller.
- Any type can be `{unsupported: true}` when Photoshop has no scriptable form; it is treated like a missing file (the fallback runs, or the tool answers NOT_SUPPORTED).
