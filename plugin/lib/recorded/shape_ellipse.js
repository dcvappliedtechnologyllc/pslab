// DRAFT, NOT RECORDED ({draft: true}). Same as shape_rect.js with an ellipse
// shape (bounding box of the ellipse); see the notes there. add_shape falls
// back to a raster fill (vector: false) when Photoshop refuses it.
const rect = require("./shape_rect.js");

const make = JSON.parse(JSON.stringify(rect.make));
const { top, left, bottom, right } = make.using.shape;
make.using.shape = { _obj: "ellipse", unitValueQuadVersion: 1, top, left, bottom, right };

module.exports = { draft: true, make, fields: { ...rect.fields } };
