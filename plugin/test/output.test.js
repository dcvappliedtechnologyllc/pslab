const test = require("node:test");
const assert = require("node:assert/strict");
const output = require("../lib/actions/output");

// Stub ps: executeAsModal records the command name and history calls; the
// document's crop/duplicate/save and the copy's methods record into `calls`;
// fs knows a set of existing folders and records folder/file creation.
// duplicate() makes the copy active; closing it activates another open
// document (as Photoshop picks the next tab); activeDocument sets are recorded.
function makeStub({
  width = 3000,
  height = 2000,
  folders = ["/exports"],
  failOn = null,
  bits = 8,
  docPath = "/exports/orig.psd",
  copyLayers = 1,
  name = "IMG_0118.JPG",
  files = [],
  docLayers = 3,
} = {}) {
  const calls = [];
  const known = new Set([...folders, ...files]);
  const fail = (name) => {
    if ([].concat(failOn).includes(name)) throw new Error(`${name} failed`);
  };
  const folderEntry = (p) => ({
    nativePath: p,
    async createFolder(name) {
      calls.push(["createFolder", p, name]);
      fail("createFolder");
      known.add(`${p}/${name}`);
      return folderEntry(`${p}/${name}`);
    },
    async createFile(name, opts) {
      calls.push(["createFile", p, name, opts]);
      const nativePath = `${p}/${name}`;
      return {
        nativePath,
        async delete() {
          calls.push(["file.delete", nativePath]);
          fail("file.delete");
        },
      };
    },
  });
  let bitsPerChannel = bits;
  const copy = {
    id: 99,
    width,
    height,
    layers: Array.from({ length: copyLayers }, (_, i) => ({ id: 500 + i })),
    get bitsPerChannel() {
      return bitsPerChannel;
    },
    set bitsPerChannel(v) {
      calls.push(["bitsPerChannel", v]);
      fail("bits");
      bitsPerChannel = v;
    },
    async convertProfile(profile, intent) {
      calls.push(["convertProfile", profile, intent]);
      fail("convertProfile");
    },
    async resizeImage(w, h, res, method) {
      calls.push(["resizeImage", w, h, res, method]);
      copy.width = w;
      copy.height = h;
    },
    async crop(b) {
      calls.push(["copy.crop", b]);
      fail("copy.crop");
      copy.width = b.right - b.left;
      copy.height = b.bottom - b.top;
    },
    async flatten() {
      calls.push(["flatten"]);
      fail("flatten");
      copy.layers = [{ id: 600 }];
    },
    saveAs: {
      async jpg(file, opts, asCopy) {
        calls.push(["copy.saveAs.jpg", file.nativePath, opts, asCopy]);
        fail("saveAs");
      },
    },
    async closeWithoutSaving() {
      calls.push(["closeWithoutSaving"]);
      documents.splice(documents.indexOf(copy), 1);
      active = other;
    },
  };
  const doc = {
    id: 1,
    name,
    width,
    height,
    path: docPath,
    layers: Array.from({ length: docLayers }, (_, i) => ({ id: 10 + i })),
    async flatten() {
      calls.push(["doc.flatten"]);
    },
    async duplicate(name, mergeLayersOnly) {
      calls.push(["duplicate", name, mergeLayersOnly]);
      documents.push(copy);
      active = copy;
      return copy;
    },
    async crop(bounds) {
      calls.push(["crop", bounds]);
    },
    async save() {
      calls.push(["save"]);
    },
    saveAs: {
      async psd(file, opts, asCopy) {
        calls.push(["saveAs.psd", file.nativePath, opts, asCopy]);
        fail("saveAs.psd");
      },
      async jpg(file, opts, asCopy) {
        calls.push(["saveAs.jpg", file.nativePath, opts, asCopy]);
      },
    },
  };
  const other = { id: 2 };
  const documents = [doc, other];
  let active = doc;
  const ps = {
    calls,
    doc,
    app: {
      documents,
      get activeDocument() {
        return active;
      },
      set activeDocument(v) {
        calls.push(["activate", v.id]);
        active = v;
      },
    },
    constants: {
      Intent: { RELATIVECOLORIMETRIC: "relCol" },
      ResampleMethod: { BICUBICSHARPER: "bicubicSharper" },
      BitsPerChannelType: { BIT8: "bitDepth8" },
    },
    core: {
      async executeAsModal(fn, options) {
        calls.push(["executeAsModal", options.commandName]);
        return fn({
          hostControl: {
            async suspendHistory(o) {
              calls.push(["suspendHistory", o.name]);
              return 7;
            },
            async resumeHistory(id, commit) {
              calls.push(["resumeHistory", commit]);
            },
          },
        });
      },
    },
    fs: {
      async getEntryWithUrl(url) {
        calls.push(["getEntryWithUrl", url]);
        const p = url.replace(/^file:/, "");
        if (!known.has(p)) throw new Error(`no entry ${p}`);
        return folderEntry(p);
      },
    },
  };
  return ps;
}

const names = (calls) => calls.map((c) => c[0]);

test("export duplicates, converts, resizes, saves copy, closes temp", async () => {
  const ps = makeStub({ width: 2000, height: 2500 });
  const out = await output.export(ps, { path: "/exports/nov1/hero.jpg", long_edge_px: 1350, quality: 10 });
  assert.deepEqual(out, { path: "/exports/nov1/hero.jpg", width: 1080, height: 1350 });
  assert.deepEqual(ps.calls, [
    ["executeAsModal", "Claude: export hero.jpg"],
    ["duplicate", "pslab export", true],
    ["convertProfile", "sRGB IEC61966-2.1", "relCol"],
    ["resizeImage", 1080, 1350, undefined, "bicubicSharper"],
    ["getEntryWithUrl", "file:/exports/nov1"],
    ["getEntryWithUrl", "file:/exports"],
    ["createFolder", "/exports", "nov1"],
    ["createFile", "/exports/nov1", "hero.jpg", { overwrite: true }],
    ["copy.saveAs.jpg", "/exports/nov1/hero.jpg", { quality: 10, embedColorProfile: true }, true],
    ["closeWithoutSaving"],
    ["activate", 1],
  ]);
  assert.equal(ps.app.activeDocument, ps.doc);
  assert.ok(!names(ps.calls).includes("flatten"));
  assert.ok(!names(ps.calls).includes("suspendHistory"));
});

test("export flattens a copy that kept its layers, before convertProfile, never the original", async () => {
  const ps = makeStub({ copyLayers: 3 });
  await output.export(ps, { path: "/exports/a.jpg", long_edge_px: 1350, quality: 10 });
  const n = names(ps.calls);
  assert.deepEqual(ps.calls[n.indexOf("duplicate")], ["duplicate", "pslab export", true]);
  assert.ok(n.includes("flatten"));
  assert.ok(n.indexOf("duplicate") < n.indexOf("flatten"));
  assert.ok(n.indexOf("flatten") < n.indexOf("convertProfile"));
  assert.ok(!n.includes("doc.flatten"));
});

test("export closes the temp copy when a step throws", async () => {
  for (const failOn of ["convertProfile", "saveAs", "createFolder"]) {
    const ps = makeStub({ failOn });
    await assert.rejects(output.export(ps, { path: "/exports/nov1/a.jpg", long_edge_px: 1350, quality: 10 }));
    assert.deepEqual(ps.calls.slice(-2), [["closeWithoutSaving"], ["activate", 1]], failOn);
    assert.equal(names(ps.calls).filter((n) => n === "closeWithoutSaving").length, 1);
    assert.equal(ps.app.activeDocument, ps.doc, failOn);
  }
  const ps = makeStub({ failOn: "flatten", copyLayers: 2 });
  await assert.rejects(output.export(ps, { path: "/exports/nov1/a.jpg", long_edge_px: 1350, quality: 10 }));
  assert.deepEqual(ps.calls.slice(-2), [["closeWithoutSaving"], ["activate", 1]]);
});

test("export reports EXPORT_DIR when the folder cannot be made", async () => {
  const ps = makeStub({ folders: [] });
  await assert.rejects(
    output.export(ps, { path: "/a/b/c/d/e/x.jpg", long_edge_px: 1350, quality: 10 }),
    (e) => e.code === "EXPORT_DIR",
  );
  assert.deepEqual(ps.calls.slice(-2), [["closeWithoutSaving"], ["activate", 1]]);
});

test("export sets 8 bits per channel only for a 16-bit copy", async () => {
  const ps8 = makeStub({ bits: 8 });
  await output.export(ps8, { path: "/exports/a.jpg", long_edge_px: 1350, quality: 10 });
  assert.ok(!names(ps8.calls).includes("bitsPerChannel"));
  const ps8enum = makeStub({ bits: "bitDepth8" });
  await output.export(ps8enum, { path: "/exports/a.jpg", long_edge_px: 1350, quality: 10 });
  assert.ok(!names(ps8enum.calls).includes("bitsPerChannel"));
  for (const bits of [16, "bitDepth16"]) {
    const ps16 = makeStub({ bits });
    await output.export(ps16, { path: "/exports/a.jpg", long_edge_px: 1350, quality: 10 });
    const n = names(ps16.calls);
    assert.deepEqual(ps16.calls[n.indexOf("bitsPerChannel")], ["bitsPerChannel", "bitDepth8"]);
    assert.ok(n.indexOf("convertProfile") < n.indexOf("bitsPerChannel"));
    assert.ok(n.indexOf("bitsPerChannel") < n.indexOf("resizeImage"));
  }
});

test("export reports EXPORT_FAILED when the bit depth cannot be set, and still cleans up", async () => {
  const ps = makeStub({ bits: 16, failOn: "bits" });
  await assert.rejects(
    output.export(ps, { path: "/exports/a.jpg", long_edge_px: 1350, quality: 10 }),
    (e) => e.code === "EXPORT_FAILED",
  );
  assert.deepEqual(ps.calls.slice(-2), [["closeWithoutSaving"], ["activate", 1]]);
});

test("export does not upscale", async () => {
  const ps = makeStub({ width: 1000, height: 800 });
  const out = await output.export(ps, { path: "/exports/a.jpg", long_edge_px: 1350, quality: 8 });
  assert.deepEqual(out, { path: "/exports/a.jpg", width: 1000, height: 800 });
  assert.ok(!names(ps.calls).includes("resizeImage"));
  assert.ok(names(ps.calls).includes("copy.saveAs.jpg"));
});

test("export validates args before touching Photoshop", async () => {
  const ps = makeStub();
  await assert.rejects(output.export(ps, { path: "relative/a.jpg", long_edge_px: 1350, quality: 10 }));
  await assert.rejects(output.export(ps, { path: "/exports/a.png", long_edge_px: 1350, quality: 10 }));
  await assert.rejects(output.export(ps, { path: "/exports/a.jpg", long_edge_px: 0, quality: 10 }));
  await assert.rejects(output.export(ps, { path: "/exports/a.jpg", long_edge_px: 1350, quality: 13 }));
  assert.deepEqual(ps.calls, []);
});

test("crop ratio centers", async () => {
  const ps = makeStub({ width: 3000, height: 2000 });
  const out = await output.crop(ps, { ratio: "4:5" });
  const bbox = { left: 700, top: 0, right: 2300, bottom: 2000 };
  assert.deepEqual(out, { bbox });
  assert.deepEqual(ps.calls, [
    ["executeAsModal", "Claude: crop 4:5"],
    ["suspendHistory", "Claude: crop 4:5"],
    ["crop", bbox],
    ["resumeHistory", true],
  ]);
});

test("crop ratio wider than the document keeps full width", async () => {
  const ps = makeStub({ width: 1000, height: 2000 });
  const out = await output.crop(ps, { ratio: "16:9" });
  assert.deepEqual(out, { bbox: { left: 0, top: 719, right: 1000, bottom: 1281 } });
});

test("crop bbox applies the box and names the step", async () => {
  const ps = makeStub();
  const bbox = { left: 10, top: 20, right: 110, bottom: 220 };
  const out = await output.crop(ps, { bbox });
  assert.deepEqual(out, { bbox });
  assert.deepEqual(ps.calls[0], ["executeAsModal", "Claude: crop bbox"]);
  assert.ok(ps.calls.some((c) => c[0] === "crop"));
});

test("crop rejects bad input before any step", async () => {
  const ps = makeStub();
  const bbox = { left: 0, top: 0, right: 10, bottom: 10 };
  await assert.rejects(output.crop(ps, {}), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(output.crop(ps, { ratio: "4:5", bbox }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(output.crop(ps, { ratio: "0:5" }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(output.crop(ps, { bbox: { left: 10, top: 0, right: 5, bottom: 10 } }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(output.crop(ps, { bbox: { left: 0, top: 0, right: 4000, bottom: 10 } }), (e) => e.code === "INVALID_ARGS");
  assert.deepEqual(ps.calls, []);
});

test("save without path calls doc.save()", async () => {
  const ps = makeStub();
  const out = await output.save(ps, { format: "psd" });
  assert.deepEqual(out, { path: null });
  assert.deepEqual(ps.calls, [["executeAsModal", "Claude: save"], ["save"]]);
});

test("save with path writes psd or jpg to that file", async () => {
  const ps = makeStub();
  assert.deepEqual(await output.save(ps, { format: "psd", path: "/exports/a.psd" }), { path: "/exports/a.psd" });
  assert.deepEqual(await output.save(ps, { format: "jpg", path: "/exports/b.jpg" }), { path: "/exports/b.jpg" });
  const saves = ps.calls.filter((c) => c[0].startsWith("saveAs"));
  assert.deepEqual(saves, [
    ["saveAs.psd", "/exports/a.psd", { embedColorProfile: true, maximizeCompatibility: true }, false],
    ["saveAs.jpg", "/exports/b.jpg", { quality: 12, embedColorProfile: true }, true],
  ]);
  await assert.rejects(output.save(ps, { format: "psd", path: "/exports/a.jpg" }), (e) => e.code === "INVALID_ARGS");
});

test("save without path refuses a never-saved document before any step", async () => {
  for (const docPath of [null, ""]) {
    const ps = makeStub({ docPath });
    await assert.rejects(output.save(ps, { format: "psd" }), (e) => e.code === "INVALID_ARGS" && /never been saved/.test(e.message));
    assert.deepEqual(ps.calls, []);
  }
  const throwing = makeStub();
  Object.defineProperty(throwing.doc, "path", { get() { throw new Error("no file"); } });
  await assert.rejects(output.save(throwing, { format: "psd" }), (e) => e.code === "INVALID_ARGS");
  const ps = makeStub({ docPath: null });
  assert.deepEqual(await output.save(ps, { format: "psd", path: "/exports/new.psd" }), { path: "/exports/new.psd" });
});

test("ratioBox with focus at the centre equals the centred box", () => {
  for (const [w, h, r] of [[3000, 2000, "4:5"], [1000, 2000, "16:9"], [4000, 5328, "4:5"], [4000, 5328, "9:16"]]) {
    assert.deepEqual(output.ratioBox(w, h, r, { x: w / 2, y: h / 2 }), output.ratioBox(w, h, r));
  }
});

test("ratioBox with focus near a corner clamps inside the canvas", () => {
  assert.deepEqual(output.ratioBox(3000, 2000, "4:5", { x: 10, y: 10 }), { left: 0, top: 0, right: 1600, bottom: 2000 });
  assert.deepEqual(output.ratioBox(3000, 2000, "4:5", { x: 2990, y: 1990 }), { left: 1400, top: 0, right: 3000, bottom: 2000 });
  assert.deepEqual(output.ratioBox(3000, 2000, "4:5", { x: 1000, y: 0 }), { left: 200, top: 0, right: 1800, bottom: 2000 });
});

test("crop ratio with focus reports the shifted bbox", async () => {
  const ps = makeStub({ width: 3000, height: 2000 });
  const out = await output.crop(ps, { ratio: "4:5", focus: { x: 100, y: 500 } });
  const bbox = { left: 0, top: 0, right: 1600, bottom: 2000 };
  assert.deepEqual(out, { bbox });
  assert.deepEqual(ps.calls[2], ["crop", bbox]);
});

test("crop rejects focus with bbox or outside the canvas before any step", async () => {
  const ps = makeStub({ width: 3000, height: 2000 });
  const bbox = { left: 0, top: 0, right: 10, bottom: 10 };
  await assert.rejects(output.crop(ps, { bbox, focus: { x: 5, y: 5 } }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(output.crop(ps, { ratio: "4:5", focus: { x: 3001, y: 5 } }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(output.crop(ps, { ratio: "4:5", focus: { x: -1, y: 5 } }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(output.crop(ps, { ratio: "4:5", focus: { x: "a", y: 5 } }), (e) => e.code === "INVALID_ARGS");
  assert.deepEqual(ps.calls, []);
});

test("psdStem strips image extensions and keeps other names", () => {
  assert.equal(output.psdStem("IMG_0118.JPG"), "IMG_0118");
  assert.equal(output.psdStem("a.jpeg"), "a");
  assert.equal(output.psdStem("b.HEIC"), "b");
  assert.equal(output.psdStem("c.tif"), "c");
  assert.equal(output.psdStem("d.tiff"), "d");
  assert.equal(output.psdStem("e.png"), "e");
  assert.equal(output.psdStem("f.psd"), "f");
  assert.equal(output.psdStem("Untitled-1"), "Untitled-1");
  assert.equal(output.psdStem("room copy"), "room copy");
  assert.equal(output.psdStem("a/b.jpg"), "a-b");
});

test("save_psd writes <stem>.psd as a copy, no history state", async () => {
  const ps = makeStub({ name: "IMG_0118.JPG", docPath: "/photos/IMG_0118.JPG" });
  const out = await output.save_psd(ps, { folder: "/exports/nov1" });
  assert.deepEqual(out, { path: "/exports/nov1/IMG_0118.psd", layers: 3 });
  assert.deepEqual(ps.calls, [
    ["executeAsModal", "Claude: save_psd"],
    ["getEntryWithUrl", "file:/exports/nov1/IMG_0118.psd"],
    ["getEntryWithUrl", "file:/exports/nov1"],
    ["getEntryWithUrl", "file:/exports"],
    ["createFolder", "/exports", "nov1"],
    ["createFile", "/exports/nov1", "IMG_0118.psd", { overwrite: false }],
    ["saveAs.psd", "/exports/nov1/IMG_0118.psd", { embedColorProfile: true, maximizeCompatibility: true }, true],
  ]);
  assert.ok(!names(ps.calls).includes("suspendHistory"));
});

test("save_psd uses -edit when the open document is the target file", async () => {
  const ps = makeStub({ name: "room.psd", docPath: "/Exports/Room.PSD", folders: ["/exports"] });
  const out = await output.save_psd(ps, { folder: "/exports" });
  assert.equal(out.path, "/exports/room-edit.psd");
});

test("save_psd picks -2 then -3 when the name is taken", async () => {
  const ps = makeStub({ files: ["/exports/IMG_0118.psd"] });
  assert.equal((await output.save_psd(ps, { folder: "/exports" })).path, "/exports/IMG_0118-2.psd");
  const ps3 = makeStub({ files: ["/exports/IMG_0118.psd", "/exports/IMG_0118-2.psd"] });
  assert.equal((await output.save_psd(ps3, { folder: "/exports" })).path, "/exports/IMG_0118-3.psd");
});

test("save_psd answers SAVE_EXISTS after -99 and never saves", async () => {
  const files = ["/exports/IMG_0118.psd"];
  for (let n = 2; n <= 99; n++) files.push(`/exports/IMG_0118-${n}.psd`);
  const ps = makeStub({ files });
  await assert.rejects(output.save_psd(ps, { folder: "/exports" }), (e) => e.code === "SAVE_EXISTS");
  assert.ok(!names(ps.calls).includes("saveAs.psd"));
  assert.ok(!names(ps.calls).includes("createFile"));
});

test("save_psd: a failed save deletes the empty file and answers SAVE_FAILED", async () => {
  const ps = makeStub({ failOn: "saveAs.psd" });
  await assert.rejects(
    output.save_psd(ps, { folder: "/exports" }),
    (e) => e.code === "SAVE_FAILED" && /IMG_0118\.psd/.test(e.message) && /saveAs\.psd failed/.test(e.message),
  );
  const tail = ps.calls.slice(-2);
  assert.deepEqual(tail, [
    ["saveAs.psd", "/exports/IMG_0118.psd", { embedColorProfile: true, maximizeCompatibility: true }, true],
    ["file.delete", "/exports/IMG_0118.psd"],
  ]);
});

test("save_psd: a failed delete after a failed save still answers SAVE_FAILED", async () => {
  const ps = makeStub({ failOn: ["saveAs.psd", "file.delete"] });
  await assert.rejects(
    output.save_psd(ps, { folder: "/exports" }),
    (e) => e.code === "SAVE_FAILED" && /saveAs\.psd failed/.test(e.message),
  );
  assert.ok(names(ps.calls).includes("file.delete"));
});

test("save_psd works for a never-saved document", async () => {
  const ps = makeStub({ name: "Untitled-1", docPath: null });
  assert.equal((await output.save_psd(ps, { folder: "/exports" })).path, "/exports/Untitled-1.psd");
});

test("save_psd validates the folder before touching Photoshop", async () => {
  const ps = makeStub();
  for (const folder of [undefined, "rel/dir", "/exports/../etc", 5]) {
    await assert.rejects(output.save_psd(ps, { folder }), (e) => e.code === "INVALID_ARGS");
  }
  assert.deepEqual(ps.calls, []);
});

test("export preset post crops the copy to 4:5 and resizes to 1080x1350", async () => {
  const ps = makeStub({ width: 4000, height: 5328, copyLayers: 2 });
  const out = await output.export(ps, { path: "/exports/p.jpg", preset: "post", quality: 10 });
  const bbox = { left: 0, top: 164, right: 4000, bottom: 5164 };
  assert.deepEqual(bbox, output.ratioBox(4000, 5328, "4:5"));
  assert.deepEqual(out, { path: "/exports/p.jpg", width: 1080, height: 1350, preset: "post", crop_bbox: bbox });
  const n = names(ps.calls);
  assert.deepEqual(ps.calls[n.indexOf("copy.crop")], ["copy.crop", bbox]);
  assert.deepEqual(ps.calls[n.indexOf("resizeImage")], ["resizeImage", 1080, 1350, undefined, "bicubicSharper"]);
  const order = ["duplicate", "flatten", "copy.crop", "convertProfile", "resizeImage", "copy.saveAs.jpg", "closeWithoutSaving"];
  const idx = order.map((x) => n.indexOf(x));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx);
  assert.ok(!n.includes("crop"), "the open document is never cropped");
});

test("export preset story crops to 9:16 and resizes to 1080x1920", async () => {
  const ps = makeStub({ width: 4000, height: 5328 });
  const out = await output.export(ps, { path: "/exports/s.jpg", preset: "story", quality: 10 });
  const bbox = output.ratioBox(4000, 5328, "9:16");
  assert.equal(bbox.right - bbox.left, 2997);
  assert.deepEqual(out, { path: "/exports/s.jpg", width: 1080, height: 1920, preset: "story", crop_bbox: bbox });
});

test("export preset with focus shifts the crop", async () => {
  const ps = makeStub({ width: 4000, height: 5328 });
  const out = await output.export(ps, { path: "/exports/s.jpg", preset: "story", focus: { x: 3900, y: 100 }, quality: 10 });
  assert.deepEqual(out.crop_bbox, { left: 1003, top: 0, right: 4000, bottom: 5328 });
  assert.deepEqual(ps.calls.find((c) => c[0] === "copy.crop"), ["copy.crop", out.crop_bbox]);
});

test("export preset ignores long_edge_px and never upscales a small copy", async () => {
  const ps = makeStub({ width: 800, height: 1200 });
  const out = await output.export(ps, { path: "/exports/s.jpg", preset: "post", long_edge_px: 5, quality: 10 });
  assert.deepEqual(out, { path: "/exports/s.jpg", width: 800, height: 1000, preset: "post", crop_bbox: { left: 0, top: 100, right: 800, bottom: 1100 } });
  assert.ok(!names(ps.calls).includes("resizeImage"));
});

test("export preset closes the copy when its crop fails", async () => {
  const ps = makeStub({ width: 4000, height: 5328, failOn: "copy.crop" });
  await assert.rejects(output.export(ps, { path: "/exports/s.jpg", preset: "post", quality: 10 }));
  assert.deepEqual(ps.calls.slice(-2), [["closeWithoutSaving"], ["activate", 1]]);
});

test("export rejects a bad preset, focus without preset, or focus outside before any step", async () => {
  const ps = makeStub({ width: 4000, height: 5328 });
  await assert.rejects(output.export(ps, { path: "/exports/a.jpg", preset: "reel", quality: 10 }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(
    output.export(ps, { path: "/exports/a.jpg", long_edge_px: 1350, focus: { x: 1, y: 1 }, quality: 10 }),
    (e) => e.code === "INVALID_ARGS",
  );
  await assert.rejects(
    output.export(ps, { path: "/exports/a.jpg", preset: "post", focus: { x: 1, y: 6000 }, quality: 10 }),
    (e) => e.code === "INVALID_ARGS",
  );
  assert.deepEqual(ps.calls, []);
});
