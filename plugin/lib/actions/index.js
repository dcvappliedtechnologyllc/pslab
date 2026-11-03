// Every action the plugin answers, by name. The server's MCP tool names must
// match these keys exactly (server/test/tool-names.test.ts).
const see = require("./see");
const dev = require("./dev");
const edit = require("./edit");
const composite = require("./composite");
const output = require("./output");
const masks = require("./masks");

module.exports = {
  get_document: see.get_document,
  open_document: see.open_document,
  render_preview: see.render_preview,
  region_stats: see.region_stats,
  dev_events: dev.dev_events,
  add_adjustment: edit.add_adjustment,
  add_pixel_layer: edit.add_pixel_layer,
  mask_from_polygon: edit.mask_from_polygon,
  mask_from_subject: edit.mask_from_subject,
  paint_mask: edit.paint_mask,
  set_layer: edit.set_layer,
  mask_from_luminance: masks.mask_from_luminance,
  mask_gradient: masks.mask_gradient,
  mask_from_color: masks.mask_from_color,
  preview_mask: masks.preview_mask,
  delete_layer: edit.delete_layer,
  set_adjustment: edit.set_adjustment,
  white_balance: edit.white_balance,
  select_object: composite.select_object,
  copy_to: composite.copy_to,
  refine_edge: composite.refine_edge,
  match_tone: composite.match_tone,
  blur_layer: composite.blur_layer,
  crop: output.crop,
  export: output.export,
  save: output.save,
};
