const test = require("node:test");
const assert = require("node:assert/strict");
const workflow = require("../lib/actions/workflow");

const modalCount = (ps) => ps.calls.filter((c) => c[0] === "executeAsModal").length;

// ---------- copy_layers_to ----------

// src (id 1): Curves 12 (top), Light 11, Background 10. dst (id 2): Background 20.
// A third document (id 3) is active at the start, so restoring it is observable.
// A duplicate into dst lands just above dst's Background, so only the
// move-to-front puts the stack on top.
function makeCopyStub({ dupThrows = false } = {}) {
  const calls = [];
  let nextId = 100;
  const makeDoc = (id, name) => ({ id, name, layers: [], activeLayers: [] });
  const src = makeDoc(1, "0092.jpg");
  const dst = makeDoc(2, "0093.jpg");
  const third = makeDoc(3, "other.psd");
  function makeLayer(doc, id, name, kind, extra = {}) {
    return {
      id,
      name,
      kind,
      ...extra,
      async duplicate(target) {
        calls.push(["duplicate", this.id, target.id]);
        if (dupThrows) throw new Error("duplicate failed");
        const l = makeLayer(target, nextId++, this.name, this.kind);
        target.layers.splice(Math.max(0, target.layers.length - 1), 0, l);
        target.activeLayers = [l];
        return l;
      },
    };
  }
  src.layers = [
    makeLayer(src, 12, "Curves 1", "curves"),
    makeLayer(src, 11, "Light 1", "brightnessContrast"),
    makeLayer(src, 10, "Background", "pixel", { isBackgroundLayer: true }),
  ];
  dst.layers = [makeLayer(dst, 20, "Background", "pixel", { isBackgroundLayer: true })];
  let active = third;
  const ps = {
    calls,
    src,
    dst,
    app: {
      documents: [src, dst, third],
      get activeDocument() {
        return active;
      },
      set activeDocument(v) {
        calls.push(["activate", v.id]);
        active = v;
      },
    },
    core: {
      async executeAsModal(fn, options) {
        calls.push(["executeAsModal", options.commandName]);
        return fn({
          hostControl: {
            async suspendHistory(o) {
              calls.push(["suspendHistory", o]);
              return o.documentID * 10;
            },
            async resumeHistory(id, commit) {
              calls.push(["resumeHistory", id, commit]);
            },
          },
        });
      },
    },
    action: {
      async batchPlay(descs) {
        calls.push(["batchPlay", descs]);
        for (const desc of descs) {
          if (desc._obj === "move") {
            const i = active.layers.findIndex((l) => l.id === desc._target[0]._id);
            const [l] = active.layers.splice(i, 1);
            active.layers.unshift(l);
          }
        }
        return descs.map(() => ({}));
      },
    },
  };
  return ps;
}

test("copy_layers_to: one state in dst only, stack order kept, ids in args order, dst active", async () => {
  const ps = makeCopyStub();
  const r = await workflow.copy_layers_to(ps, { src_doc: 1, dst_doc: 2, layers: [12, 11] });
  // bottom-most (11) is copied first and gets id 100
  assert.deepEqual(r, { layer_ids: [101, 100], names: ["Curves 1", "Light 1"] });
  assert.deepEqual(ps.dst.layers.map((l) => l.id), [101, 100, 20]);
  assert.equal(modalCount(ps), 1);
  assert.deepEqual(ps.calls.filter((c) => c[0] === "suspendHistory").map((c) => c[1]), [
    { documentID: 2, name: "Claude: copy_layers_to, 2 layers" },
  ]);
  assert.deepEqual(ps.calls.filter((c) => c[0] === "resumeHistory"), [["resumeHistory", 20, true]]);
  assert.deepEqual(ps.calls.filter((c) => c[0] === "duplicate"), [
    ["duplicate", 11, 2],
    ["duplicate", 12, 2],
  ]);
  const moves = ps.calls.filter((c) => c[0] === "batchPlay" && c[1].some((d) => d._obj === "move"));
  assert.deepEqual(moves[0][1], [
    { _obj: "select", _target: [{ _ref: "layer", _id: 100 }], makeVisible: false, _options: { dialogOptions: "dontDisplay" } },
    { _obj: "move", _target: [{ _ref: "layer", _id: 100 }], to: { _ref: "layer", _enum: "ordinal", _value: "front" }, _options: { dialogOptions: "dontDisplay" } },
  ]);
  // dst is activated once; src is never activated and nothing is selected in it
  assert.deepEqual(ps.calls.filter((c) => c[0] === "activate"), [["activate", 2]]);
  const selected = ps.calls
    .filter((c) => c[0] === "batchPlay")
    .flatMap((c) => c[1])
    .filter((d) => d._obj === "select")
    .map((d) => d._target[0]._id);
  assert.deepEqual(selected, [100, 101]);
  assert.equal(ps.app.activeDocument.id, 2);
});

test("copy_layers_to: one layer names its state in the singular", async () => {
  const ps = makeCopyStub();
  await workflow.copy_layers_to(ps, { src_doc: 1, dst_doc: 2, layers: [11] });
  assert.equal(ps.calls.filter((c) => c[0] === "suspendHistory")[0][1].name, "Claude: copy_layers_to, 1 layer");
});

test("copy_layers_to: rejects bad args before any modal scope", async () => {
  const ps = makeCopyStub();
  const bad = [
    [{ src_doc: 1, dst_doc: 2, layers: [] }, "INVALID_ARGS"],
    [{ src_doc: 1, dst_doc: 2 }, "INVALID_ARGS"],
    [{ src_doc: 1, dst_doc: 2, layers: [11, 11] }, "INVALID_ARGS"],
    [{ src_doc: 1, dst_doc: 1, layers: [11] }, "SAME_DOCUMENT"],
    [{ src_doc: 1, dst_doc: 2, layers: [11, 99] }, "NO_LAYER"],
    [{ src_doc: 1, dst_doc: 2, layers: [10] }, "INVALID_ARGS"],
    [{ src_doc: 1, dst_doc: 9, layers: [11] }, "NO_DOCUMENT"],
  ];
  for (const [args, code] of bad) {
    await assert.rejects(workflow.copy_layers_to(ps, args), (e) => e.code === code, JSON.stringify(args));
  }
  // a Background recognised by name and kind when isBackgroundLayer is missing
  delete ps.src.layers[2].isBackgroundLayer;
  await assert.rejects(
    workflow.copy_layers_to(ps, { src_doc: 1, dst_doc: 2, layers: [10] }),
    (e) => e.code === "INVALID_ARGS" && /Background cannot be copied/.test(e.message),
  );
  assert.equal(modalCount(ps), 0);
});

test("copy_layers_to: a failed duplicate rolls back dst and restores the active document", async () => {
  const ps = makeCopyStub({ dupThrows: true });
  await assert.rejects(workflow.copy_layers_to(ps, { src_doc: 1, dst_doc: 2, layers: [12] }), /duplicate failed/);
  assert.deepEqual(ps.calls.filter((c) => c[0] === "resumeHistory"), [["resumeHistory", 20, false]]);
  assert.equal(ps.app.activeDocument.id, 3);
});

// ---------- open_folder ----------

function makeFolderStub({ names = [], isFolder = true, missing = false, failOn = null } = {}) {
  const calls = [];
  const docs = [{ id: 1, name: "already.psd" }];
  let active = docs[0];
  let nextId = 50;
  const file = (name) => ({ name, isFile: true, isFolder: false });
  const entries = names.map(file).concat([{ name: "sub.jpg", isFile: false, isFolder: true }]);
  return {
    calls,
    app: {
      documents: docs,
      get activeDocument() {
        return active;
      },
      async open(entry) {
        calls.push(["open", entry.name]);
        if (entry.name === failOn) throw new Error("unsupported format");
        const d = { id: nextId++, name: entry.name };
        docs.push(d);
        active = d;
        return d;
      },
    },
    core: {
      async executeAsModal(fn, options) {
        calls.push(["executeAsModal", options.commandName]);
        return fn({ hostControl: {} });
      },
    },
    fs: {
      async getEntryWithUrl(url) {
        calls.push(["getEntryWithUrl", url]);
        if (missing) throw new Error("no such file");
        return {
          isFolder,
          async getEntries() {
            calls.push(["getEntries"]);
            return entries;
          },
        };
      },
    },
  };
}

test("open_folder: default pattern keeps image files, sorts numerically, one modal scope", async () => {
  const ps = makeFolderStub({ names: ["IMG_10.jpg", "notes.txt", "IMG_9.HEIC", "IMG_2.psd", ".DS_Store", "raw.CR3"] });
  const r = await workflow.open_folder(ps, { path: "/Users/d/shoot/" });
  assert.deepEqual(r.docs, [
    { id: 50, name: "IMG_2.psd", path: "/Users/d/shoot/IMG_2.psd" },
    { id: 51, name: "IMG_9.HEIC", path: "/Users/d/shoot/IMG_9.HEIC" },
    { id: 52, name: "IMG_10.jpg", path: "/Users/d/shoot/IMG_10.jpg" },
  ]);
  assert.equal(r.count, 3);
  assert.deepEqual(r.open_docs.map((d) => d.id), [1, 50, 51, 52]);
  assert.deepEqual(ps.calls.filter((c) => c[0] === "executeAsModal"), [["executeAsModal", "Open folder"]]);
  assert.deepEqual(ps.calls[0], ["getEntryWithUrl", "file:/Users/d/shoot/"]);
});

test("open_folder: pattern is a case-insensitive glob with * and ?", async () => {
  const ps = makeFolderStub({ names: ["a1.jpg", "A2.JPG", "a10.jpg", "b1.jpg", "a1.png"] });
  const r = await workflow.open_folder(ps, { path: "/x", pattern: "a?.jpg" });
  assert.deepEqual(r.docs.map((d) => d.name), ["a1.jpg", "A2.JPG"]);
  const m = workflow.nameMatcher("IMG_(1)*.jpg");
  assert.equal(m("img_(1) copy.JPG"), true);
  assert.equal(m("IMG_1.jpg"), false);
});

test("open_folder: rejects bad args before any modal scope", async () => {
  const ps = makeFolderStub({ names: ["a.jpg"] });
  await assert.rejects(workflow.open_folder(ps, { path: "rel/dir" }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(workflow.open_folder(ps, { path: "/x", pattern: "sub/*.jpg" }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(workflow.open_folder(ps, { path: "/x", pattern: "" }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(
    workflow.open_folder(makeFolderStub({ missing: true }), { path: "/nope" }),
    (e) => e.code === "FILE_NOT_FOUND",
  );
  const notFolder = makeFolderStub({ isFolder: false });
  await assert.rejects(workflow.open_folder(notFolder, { path: "/x/a.jpg" }), (e) => e.code === "INVALID_ARGS");
  const many = makeFolderStub({ names: Array.from({ length: 51 }, (_, i) => `f${i}.jpg`) });
  await assert.rejects(workflow.open_folder(many, { path: "/x" }), (e) => e.code === "TOO_MANY_FILES" && /51 files/.test(e.message));
  for (const s of [ps, notFolder, many]) assert.equal(modalCount(s), 0);
});

test("open_folder: no match opens nothing and needs no modal scope", async () => {
  const ps = makeFolderStub({ names: ["notes.txt"] });
  const r = await workflow.open_folder(ps, { path: "/x" });
  assert.equal(r.count, 0);
  assert.equal(modalCount(ps), 0);
});

test("open_folder: a failing file stops the run, earlier documents stay open, OPEN_FAILED lists both", async () => {
  const ps = makeFolderStub({ names: ["1.jpg", "2.jpg", "3.jpg"], failOn: "2.jpg" });
  await assert.rejects(workflow.open_folder(ps, { path: "/x" }), (e) => {
    assert.equal(e.code, "OPEN_FAILED");
    const json = JSON.parse(e.message.slice(e.message.indexOf("{")));
    assert.deepEqual(json, { opened: [{ id: 50, name: "1.jpg", path: "/x/1.jpg" }], failed: { name: "2.jpg", message: "unsupported format" } });
    return true;
  });
  assert.deepEqual(ps.calls.filter((c) => c[0] === "open").map((c) => c[1]), ["1.jpg", "2.jpg"]);
  assert.equal(ps.app.documents.length, 2);
});

// ---------- compare_preview / contact_sheet imaging stub ----------

// Documents of given sizes; each document's composite is a solid grey whose
// value is 40 + 50 * (visible layers), so "before" and "after" differ.
// Records getPixels / createImageDataFromBuffer / encode / dispose calls.
function makeImagingStub({ docs, getPixelsThrowsOn = null, components = 3 } = {}) {
  const calls = [];
  let active = docs[docs.length - 1];
  let reads = 0;
  const ps = {
    calls,
    app: {
      documents: docs,
      get activeDocument() {
        return active;
      },
      set activeDocument(v) {
        calls.push(["activate", v.id]);
        active = v;
      },
    },
    core: {
      async executeAsModal(fn, options) {
        calls.push(["executeAsModal", options.commandName]);
        return fn({
          hostControl: {
            async suspendHistory(o) {
              calls.push(["suspendHistory", o]);
              return 77;
            },
            async resumeHistory(id, commit) {
              calls.push(["resumeHistory", id, commit]);
            },
          },
        });
      },
    },
    imaging: {
      async getPixels(opts) {
        calls.push(["getPixels", opts]);
        reads++;
        if (getPixelsThrowsOn === reads) throw new Error("getPixels failed");
        const d = docs.find((x) => x.id === opts.documentID);
        const sw = opts.sourceBounds.right - opts.sourceBounds.left;
        const sh = opts.sourceBounds.bottom - opts.sourceBounds.top;
        let w = sw;
        let h = sh;
        if (opts.targetSize && opts.targetSize.width) {
          w = opts.targetSize.width;
          h = Math.round((sh * w) / sw);
        } else if (opts.targetSize && opts.targetSize.height) {
          h = opts.targetSize.height;
          w = Math.round((sw * h) / sh);
        }
        const visible = (d.layers || []).filter((l) => l.visible).length;
        const v = d.fill ?? 40 + 50 * visible;
        const data = new Uint8Array(w * h * components).fill(v);
        return {
          imageData: {
            width: w,
            height: h,
            components,
            async getData(o) {
              calls.push(["getData", o]);
              return data;
            },
            dispose() {
              calls.push(["dispose", "read"]);
            },
          },
        };
      },
      async createImageDataFromBuffer(data, opts) {
        calls.push(["createImageDataFromBuffer", opts, data]);
        return {
          width: opts.width,
          height: opts.height,
          dispose() {
            calls.push(["dispose", "encode"]);
          },
        };
      },
      async encodeImageData(o) {
        calls.push(["encodeImageData", { base64: o.base64, width: o.imageData.width }]);
        return "JPEGB64";
      },
    },
  };
  return ps;
}

const layer = (id, visible = true) => ({ id, name: `L${id}`, visible });

test("compare_preview: before on the left, after on the right, one rolled-back scratch state", async () => {
  const d = { id: 5, name: "a.psd", width: 3000, height: 2000, layers: [layer(3), layer(2), layer(1)] };
  const ps = makeImagingStub({ docs: [d, { id: 6, name: "b.psd", width: 10, height: 10, layers: [] }] });
  const r = await workflow.compare_preview(ps, { doc: 5, layer_ids_off: [3, 2] });
  // half fits (1500 - 8) / 2 = 746 wide: 746 x 497
  assert.deepEqual(r.half, { w: 746, h: 497 });
  assert.deepEqual(r.preview, { w: 746 * 2 + 8, h: 497 });
  assert.equal(r.left, "before");
  assert.equal(r.right, "after");
  assert.equal(r.jpeg_base64, "JPEGB64");
  assert.equal(r.scale, 3000 / 746);
  assert.deepEqual(r.layers_off, [3, 2]);
  // one scratch state, always rolled back
  assert.deepEqual(ps.calls.filter((c) => c[0] === "suspendHistory"), [["suspendHistory", { documentID: 5, name: "Claude: compare_preview" }]]);
  assert.deepEqual(ps.calls.filter((c) => c[0] === "resumeHistory"), [["resumeHistory", 77, false]]);
  // first read is "after" (3 visible), second "before" (1 visible)
  const [enc] = ps.calls.filter((c) => c[0] === "createImageDataFromBuffer");
  assert.deepEqual(enc[1], { width: 1500, height: 497, components: 3, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", chunky: true });
  const data = enc[2];
  assert.equal(data[0], 40 + 50 * 1);
  assert.equal(data[746 * 3], 128);
  assert.equal(data[(746 + 8) * 3], 40 + 50 * 3);
  const reads = ps.calls.filter((c) => c[0] === "getPixels").map((c) => c[1]);
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[0], {
    documentID: 5,
    sourceBounds: { left: 0, top: 0, right: 3000, bottom: 2000 },
    componentSize: 8,
    applyAlpha: true,
    colorSpace: "RGB",
    targetSize: { width: 746 },
  });
  // visibility restored, everything disposed, original active document back
  assert.deepEqual(d.layers.map((l) => l.visible), [true, true, true]);
  assert.equal(ps.calls.filter((c) => c[0] === "dispose").length, 3);
  assert.equal(ps.app.activeDocument.id, 6);
});

test("compare_preview: a tall canvas is limited by height; a small one is read at full size", async () => {
  const tall = { id: 5, name: "t.psd", width: 1000, height: 4000, layers: [layer(1)] };
  const ps = makeImagingStub({ docs: [tall] });
  const r = await workflow.compare_preview(ps, { layer_ids_off: [1], max_px: 1000 });
  assert.deepEqual(ps.calls.find((c) => c[0] === "getPixels")[1].targetSize, { height: 1000 });
  assert.deepEqual(r.half, { w: 250, h: 1000 });
  const small = { id: 5, name: "s.psd", width: 300, height: 200, layers: [layer(1)] };
  const ps2 = makeImagingStub({ docs: [small] });
  const r2 = await workflow.compare_preview(ps2, { layer_ids_off: [1] });
  assert.equal("targetSize" in ps2.calls.find((c) => c[0] === "getPixels")[1], false);
  assert.equal(r2.scale, 1);
});

test("compare_preview: visibility is restored and the state rolled back when getPixels throws", async () => {
  const d = { id: 5, name: "a.psd", width: 300, height: 200, layers: [layer(2), layer(1, false)] };
  const ps = makeImagingStub({ docs: [d], getPixelsThrowsOn: 2 });
  await assert.rejects(workflow.compare_preview(ps, { layer_ids_off: [2, 1] }), /getPixels failed/);
  assert.deepEqual(d.layers.map((l) => l.visible), [true, false]);
  assert.deepEqual(ps.calls.filter((c) => c[0] === "resumeHistory"), [["resumeHistory", 77, false]]);
});

test("compare_preview: rejects bad args before any modal scope", async () => {
  const d = { id: 5, name: "a.psd", width: 300, height: 200, layers: [layer(1)] };
  const ps = makeImagingStub({ docs: [d] });
  const bad = [
    [{ layer_ids_off: [] }, "INVALID_ARGS"],
    [{}, "INVALID_ARGS"],
    [{ layer_ids_off: [1], max_px: 199 }, "INVALID_ARGS"],
    [{ layer_ids_off: [1], max_px: 4001 }, "INVALID_ARGS"],
    [{ layer_ids_off: [1, 9] }, "NO_LAYER"],
    [{ doc: 8, layer_ids_off: [1] }, "NO_DOCUMENT"],
  ];
  for (const [args, code] of bad) {
    await assert.rejects(workflow.compare_preview(ps, args), (e) => e.code === code, JSON.stringify(args));
  }
  assert.equal(modalCount(ps), 0);
});

// ---------- contact_sheet ----------

test("contact_sheet: one read-only scope, cells fit and centered, sheet long edge = max_px", async () => {
  const docs = [
    { id: 1, name: "a.jpg", width: 3000, height: 2000, fill: 10 },
    { id: 2, name: "b.jpg", width: 2000, height: 3000, fill: 20 },
    { id: 3, name: "c.jpg", width: 100, height: 50, fill: 30 },
  ];
  const ps = makeImagingStub({ docs });
  const r = await workflow.contact_sheet(ps, { docs: [3, 1, 2] });
  // cols 2, rows 2, cell floor((1500 - 24) / 2) = 738
  assert.deepEqual(r.sheet, { w: 1500, h: 1500, cols: 2, rows: 2, cell: 738 });
  assert.deepEqual(ps.calls.filter((c) => c[0] === "executeAsModal"), [["executeAsModal", "Contact sheet"]]);
  assert.equal(ps.calls.filter((c) => c[0] === "suspendHistory").length, 0);
  const reads = ps.calls.filter((c) => c[0] === "getPixels").map((c) => c[1]);
  assert.deepEqual(reads.map((o) => o.documentID), [3, 1, 2]);
  assert.equal("targetSize" in reads[0], false);
  assert.deepEqual(reads[1].targetSize, { width: 738 });
  assert.deepEqual(reads[2].targetSize, { height: 738 });
  assert.deepEqual(r.cells, [
    { doc: 3, name: "c.jpg", x: 8 + 319, y: 8 + 344, w: 100, h: 50 },
    { doc: 1, name: "a.jpg", x: 754, y: 8 + 123, w: 738, h: 492 },
    { doc: 2, name: "b.jpg", x: 8 + 123, y: 754, w: 492, h: 738 },
  ]);
  const [enc] = ps.calls.filter((c) => c[0] === "createImageDataFromBuffer");
  const data = enc[2];
  const at = (x, y) => data[(y * 1500 + x) * 3];
  assert.equal(at(352, 352), 30);
  assert.equal(at(754, 131), 10);
  assert.equal(at(131, 754), 20);
  assert.equal(at(0, 0), 128);
  assert.equal(r.jpeg_base64, "JPEGB64");
  assert.equal(ps.calls.filter((c) => c[0] === "dispose").length, 4);
});

test("contact_sheet: explicit cols; one column of many rows sizes cells by rows", async () => {
  const docs = [1, 2, 3].map((id) => ({ id, name: `${id}.jpg`, width: 400, height: 400 }));
  const ps = makeImagingStub({ docs });
  const r = await workflow.contact_sheet(ps, { docs: [1, 2, 3], cols: 1, max_px: 500 });
  // across = 3 rows: floor((500 - 32) / 3) = 156
  assert.deepEqual(r.sheet, { w: 172, h: 500, cols: 1, rows: 3, cell: 156 });
});

test("contact_sheet: rejects bad args before any modal scope", async () => {
  const docs = [{ id: 1, name: "a.jpg", width: 10, height: 10 }];
  const ps = makeImagingStub({ docs });
  const bad = [
    [{ docs: [] }, "INVALID_ARGS"],
    [{}, "INVALID_ARGS"],
    [{ docs: Array.from({ length: 25 }, () => 1) }, "INVALID_ARGS"],
    [{ docs: [1], cols: 0 }, "INVALID_ARGS"],
    [{ docs: [1], cols: 9 }, "INVALID_ARGS"],
    [{ docs: [1], max_px: 399 }, "INVALID_ARGS"],
    [{ docs: [1], max_px: 4001 }, "INVALID_ARGS"],
    [{ docs: [1, 7] }, "NO_DOCUMENT"],
    [{ docs: Array.from({ length: 24 }, () => 1), cols: 1, max_px: 400 }, "INVALID_ARGS"],
  ];
  for (const [args, code] of bad) {
    await assert.rejects(workflow.contact_sheet(ps, args), (e) => e.code === code, JSON.stringify(args));
  }
  assert.equal(modalCount(ps), 0);
});
