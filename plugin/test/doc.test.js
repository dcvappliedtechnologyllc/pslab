const test = require("node:test");
const assert = require("node:assert/strict");
const { bitsOf, docSummary, findLayer, selectLayer } = require("../lib/doc");
const { get_document } = require("../lib/actions/see");

function layer(id, name, extra = {}) {
  return {
    id,
    name,
    kind: "pixel",
    visible: true,
    opacity: 100,
    blendMode: "normal",
    isClippingMask: false,
    layers: undefined,
    ...extra,
  };
}

function makeDoc(id, name, layers, extra = {}) {
  return {
    id,
    name,
    width: 4000,
    height: 3000,
    resolution: 300,
    colorProfileName: "sRGB IEC61966-2.1",
    bitsPerChannel: 16,
    activeLayers: [],
    layers,
    ...extra,
  };
}

function makeStub({ docs = [], masked = [] } = {}) {
  const calls = [];
  return {
    calls,
    app: {
      documents: docs,
      get activeDocument() {
        return docs[0] ?? null;
      },
    },
    action: {
      batchPlay(descriptors, options) {
        calls.push({ descriptors, options });
        const d = descriptors[0];
        if (d._obj === "get") {
          const ids = descriptors.map((x) => x._target[1]._id);
          if (ids.includes(999)) throw new Error("boom");
          return ids.map((id) => ({ hasUserMask: masked.includes(id) }));
        }
        return [{}];
      },
    },
  };
}

function nestedDoc() {
  const brokenKind = layer(5, "Broken");
  Object.defineProperty(brokenKind, "kind", {
    get() {
      throw new Error("kind unavailable");
    },
  });
  const inner = layer(4, "Inner group", { kind: "group", layers: [layer(6, "Deep pixel", { isClippingMask: true })] });
  const group = layer(2, "Group", { kind: "group", blendMode: "passThrough", layers: [layer(3, "Child", { opacity: 50, visible: false }), inner] });
  return makeDoc(10, "photo.psd", [layer(1, "Top"), group, brokenKind], { activeLayers: [{ id: 3 }] });
}

test("docSummary maps document fields and nests groups as children", async () => {
  const doc = nestedDoc();
  const ps = makeStub({ docs: [doc], masked: [3] });
  const s = await docSummary(ps, doc);
  assert.equal(s.id, 10);
  assert.equal(s.name, "photo.psd");
  assert.equal(s.width, 4000);
  assert.equal(s.height, 3000);
  assert.equal(s.ppi, 300);
  assert.equal(s.profile, "sRGB IEC61966-2.1");
  assert.equal(s.bits, 16);
  assert.equal(s.activeLayerId, 3);
  assert.deepEqual(s.layers.map((l) => l.id), [1, 2, 5]);
  const group = s.layers[1];
  assert.equal(group.kind, "group");
  assert.equal(group.blend, "passThrough");
  assert.deepEqual(group.children.map((l) => l.id), [3, 4]);
  assert.deepEqual(group.children[0], {
    id: 3,
    name: "Child",
    kind: "pixel",
    visible: false,
    opacity: 50,
    blend: "normal",
    clipped: false,
    hasMask: true,
    children: [],
  });
  const deep = group.children[1].children[0];
  assert.equal(deep.id, 6);
  assert.equal(deep.clipped, true);
  assert.equal(deep.hasMask, false);
});

test("a layer whose kind getter throws yields kind 'unknown'", async () => {
  const doc = nestedDoc();
  const s = await docSummary(makeStub({ docs: [doc] }), doc);
  assert.equal(s.layers[2].kind, "unknown");
  assert.equal(s.layers[2].name, "Broken");
});

test("when the batched mask query throws, each layer is asked alone and a failing one is false", async () => {
  const doc = makeDoc(1, "a.psd", [layer(999, "Weird"), layer(8, "Masked")]);
  const ps = makeStub({ docs: [doc], masked: [8] });
  const s = await docSummary(ps, doc);
  assert.equal(s.layers[0].hasMask, false);
  assert.equal(s.layers[1].hasMask, true);
  assert.deepEqual(ps.calls.map((c) => c.descriptors.length), [2, 1, 1]);
});

test("hasMask is one batchPlay for the whole tree, targeting layer and document by id", async () => {
  const doc = nestedDoc();
  const ps = makeStub({ docs: [doc] });
  await docSummary(ps, doc);
  assert.equal(ps.calls.length, 1);
  const descriptors = ps.calls[0].descriptors;
  assert.deepEqual(descriptors.map((d) => d._target[1]._id), [1, 2, 3, 4, 6, 5]);
  assert.deepEqual(descriptors[0]._target, [
    { _property: "hasUserMask" },
    { _ref: "layer", _id: 1 },
    { _ref: "document", _id: 10 },
  ]);
  assert.equal(descriptors[0]._options.dialogOptions, "dontDisplay");
});

test("get_document of an inactive document asks for its masks by its own id", async () => {
  const b = makeDoc(11, "other.psd", [layer(1, "Bg")]);
  const ps = makeStub({ docs: [nestedDoc(), b] });
  await get_document(ps, { doc: 11 });
  assert.deepEqual(ps.calls[0].descriptors[0]._target[2], { _ref: "document", _id: 11 });
});

test("docSummary falls back to title and null activeLayerId", async () => {
  const doc = makeDoc(1, undefined, [], { title: "Untitled-1" });
  const s = await docSummary(makeStub({ docs: [doc] }), doc);
  assert.equal(s.name, "Untitled-1");
  assert.equal(s.activeLayerId, null);
  assert.deepEqual(s.layers, []);
});

test("docSummary of no document is null", async () => {
  assert.equal(await docSummary(makeStub(), null), null);
});

test("findLayer finds a nested id and returns null when absent", () => {
  const doc = nestedDoc();
  assert.equal(findLayer(doc, 6).name, "Deep pixel");
  assert.equal(findLayer(doc, 1).name, "Top");
  assert.equal(findLayer(doc, 404), null);
});

test("selectLayer batchPlays select by _id without making it visible", async () => {
  const doc = nestedDoc();
  const ps = makeStub({ docs: [doc] });
  await selectLayer(ps, doc, 6);
  assert.equal(ps.calls.length, 1);
  assert.deepEqual(ps.calls[0].descriptors, [
    { _obj: "select", _target: [{ _ref: "layer", _id: 6 }], makeVisible: false, _options: { dialogOptions: "dontDisplay" } },
  ]);
});

test("get_document returns the active document summary plus open_docs", async () => {
  const a = nestedDoc();
  const b = makeDoc(11, "other.psd", [layer(1, "Bg")]);
  const r = await get_document(makeStub({ docs: [a, b] }), {});
  assert.equal(r.id, 10);
  assert.equal(r.layers.length, 3);
  assert.deepEqual(r.open_docs, [
    { id: 10, name: "photo.psd" },
    { id: 11, name: "other.psd" },
  ]);
});

test("get_document resolves a document by id", async () => {
  const a = nestedDoc();
  const b = makeDoc(11, "other.psd", [layer(1, "Bg")]);
  const r = await get_document(makeStub({ docs: [a, b] }), { doc: 11 });
  assert.equal(r.id, 11);
  assert.equal(r.name, "other.psd");
});

test("get_document with an unknown id throws NO_DOCUMENT", async () => {
  const ps = makeStub({ docs: [nestedDoc()] });
  await assert.rejects(get_document(ps, { doc: 42 }), { code: "NO_DOCUMENT", message: "No document with id 42" });
});

test("get_document with nothing open throws NO_DOCUMENT", async () => {
  await assert.rejects(get_document(makeStub(), {}), { code: "NO_DOCUMENT", message: "No document open" });
});

test("docSummary reads the UXP bit-depth enum string and guards non-finite sizes", async () => {
  const doc = makeDoc(11, "enum.psd", [layer(1, "Top")], { bitsPerChannel: "bitDepth16", width: NaN, resolution: undefined });
  const s = await docSummary(makeStub({ docs: [doc] }), doc);
  assert.equal(s.bits, 16);
  assert.equal(s.width, 0);
  assert.equal(s.height, 3000);
  assert.equal(s.ppi, 0);
});

test("bitsOf accepts numbers and bitDepth enum strings, else 0", () => {
  assert.equal(bitsOf(8), 8);
  assert.equal(bitsOf("bitDepth8"), 8);
  assert.equal(bitsOf("bitDepth32"), 32);
  assert.equal(bitsOf("BitsPerChannelType.bitDepth16"), 16);
  assert.equal(bitsOf("weird"), 0);
  assert.equal(bitsOf(NaN), 0);
});

test("docSummary reports kind light for a brightness layer in light mode", async () => {
  const docs = [{
    id: 3, name: "x.psd", width: 10, height: 10, resolution: 72, bitsPerChannel: 8, activeLayers: [],
    layers: [
      { id: 11, name: "Light 1", kind: "brightnessContrast", visible: true, opacity: 100, blendMode: "normal" },
      { id: 12, name: "BC legacy", kind: "brightnessContrast", visible: true, opacity: 100, blendMode: "normal" },
      { id: 13, name: "Exp", kind: "exposure", visible: true, opacity: 100, blendMode: "normal" },
    ],
  }];
  const gets = [];
  const ps = {
    app: { documents: docs, activeDocument: docs[0] },
    action: {
      async batchPlay(descs) {
        gets.push(descs);
        if (descs[0]._target[0]._property === "hasUserMask") return descs.map(() => ({ hasUserMask: true }));
        return descs.map((d) => {
          const id = d._target[1]._id;
          return { adjustment: [id === 11
            ? { _obj: "brightnessEvent", brightnessMode: { _enum: "brightnessModeType", _value: "brightnessModeLight" } }
            : { _obj: "brightnessEvent", useLegacy: false }] };
        });
      },
    },
  };
  const { docSummary } = require("../lib/doc");
  const s = await docSummary(ps, docs[0]);
  assert.deepEqual(s.layers.map((l) => [l.id, l.kind]), [[11, "light"], [12, "brightnessContrast"], [13, "exposure"]]);
  const adjGets = gets.filter((d) => d[0]._target[0]._property === "adjustment");
  assert.equal(adjGets.length, 1);
  assert.deepEqual(adjGets[0].map((d) => d._target[1]._id), [11, 12]);
  assert.equal(adjGets[0][0]._target[2]._id, 3);
});

test("docSummary keeps the raw kind when the adjustment query throws", async () => {
  const docs = [{ id: 3, name: "x", width: 1, height: 1, resolution: 72, bitsPerChannel: 8, activeLayers: [],
    layers: [{ id: 11, name: "L", kind: "brightnessContrast", visible: true, opacity: 100, blendMode: "normal" }] }];
  const ps = { app: { documents: docs, activeDocument: docs[0] }, action: { async batchPlay(descs) {
    if (descs[0]._target[0]._property === "hasUserMask") return [{ hasUserMask: false }];
    throw new Error("nope");
  } } };
  const { docSummary } = require("../lib/doc");
  const s = await docSummary(ps, docs[0]);
  assert.equal(s.layers[0].kind, "brightnessContrast");
});
