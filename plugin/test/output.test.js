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
} = {}) {
  const calls = [];
  const known = new Set(folders);
  const fail = (name) => {
    if (failOn === name) throw new Error(`${name} failed`);
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
      return { nativePath: `${p}/${name}` };
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
    width,
    height,
    path: docPath,
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
