const test = require("node:test");
const assert = require("node:assert/strict");
const { runStep, runScratch, runRead, bp } = require("../lib/step");

// Stub ps whose executeAsModal runs the callback with a recording hostControl.
// Like the real API, an error thrown inside the modal callback loses its code
// when it crosses the boundary: we re-wrap it as a plain Error.
function makeStub({
  suspendThrows = false,
  resumeThrows = false,
  modalReject = null,
  batchPlayResult = null,
} = {}) {
  const calls = [];
  const ps = {
    calls,
    core: {
      async executeAsModal(fn, options) {
        calls.push(["executeAsModal", options]);
        if (modalReject) throw modalReject;
        const ctx = {
          hostControl: {
            async suspendHistory(opts) {
              calls.push(["suspendHistory", opts]);
              if (suspendThrows) throw new Error("suspend failed");
              return 42;
            },
            async resumeHistory(id, commit) {
              calls.push(["resumeHistory", id, commit]);
              if (resumeThrows) throw new Error("resume failed");
            },
          },
        };
        try {
          return await fn(ctx);
        } catch (e) {
          throw new Error(e.message); // code stripped at the boundary
        }
      },
    },
    action: {
      async batchPlay(descs, options) {
        calls.push(["batchPlay", descs, options]);
        return batchPlayResult ?? descs.map(() => ({}));
      },
    },
  };
  return ps;
}

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const MODAL_OPTS = { commandName: "Do Thing", interactive: false, timeOut: 30 };

test("runStep success: one suspension, commits, returns fn's value", async () => {
  const ps = makeStub();
  const seen = [];
  const out = await runStep(ps, "Do Thing", 7, async (ctx) => {
    seen.push(ctx);
    return { ok: 1 };
  });
  assert.deepEqual(out, { ok: 1 });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].hostControl);
  assert.deepEqual(ps.calls, [
    ["executeAsModal", MODAL_OPTS],
    ["suspendHistory", { documentID: 7, name: "Do Thing" }],
    ["resumeHistory", 42, true],
  ]);
});

test("runStep fn throws: rolls back and rejects with same code and message", async () => {
  const ps = makeStub();
  await assert.rejects(
    runStep(ps, "Do Thing", 7, async () => {
      throw codedError("LAYER_NOT_FOUND", "no layer 9");
    }),
    (e) => {
      assert.ok(e instanceof Error);
      assert.equal(e.code, "LAYER_NOT_FOUND");
      assert.equal(e.message, "no layer 9");
      return true;
    }
  );
  assert.deepEqual(ps.calls, [
    ["executeAsModal", MODAL_OPTS],
    ["suspendHistory", { documentID: 7, name: "Do Thing" }],
    ["resumeHistory", 42, false],
  ]);
});

test("runStep fn throws an error without code: code defaults to STEP_FAILED", async () => {
  const ps = makeStub();
  await assert.rejects(
    runStep(ps, "Do Thing", 7, async () => {
      throw new Error("plain");
    }),
    (e) => e.code === "STEP_FAILED" && e.message === "plain"
  );
  assert.deepEqual(ps.calls.at(-1), ["resumeHistory", 42, false]);
});

test("runStep resumeHistory(false) throws: the original error wins", async () => {
  const ps = makeStub({ resumeThrows: true });
  await assert.rejects(
    runStep(ps, "Do Thing", 7, async () => {
      throw codedError("BATCHPLAY", "orig");
    }),
    (e) => e.code === "BATCHPLAY" && e.message === "orig"
  );
  assert.deepEqual(ps.calls.at(-1), ["resumeHistory", 42, false]);
});

test("runStep commit resumeHistory(true) throws: rejects with a coded error", async () => {
  const ps = makeStub({ resumeThrows: true });
  await assert.rejects(
    runStep(ps, "Do Thing", 7, async () => "ok"),
    (e) => e instanceof Error && e.code === "STEP_FAILED" && e.message === "resume failed"
  );
  // commit attempted first, then a rollback attempt
  assert.deepEqual(
    ps.calls.filter((c) => c[0] === "resumeHistory"),
    [
      ["resumeHistory", 42, true],
      ["resumeHistory", 42, false],
    ]
  );
});

test("runStep suspendHistory throws: fn never runs, no resume, coded rejection", async () => {
  const ps = makeStub({ suspendThrows: true });
  let ran = false;
  await assert.rejects(
    runStep(ps, "Do Thing", 7, async () => {
      ran = true;
    }),
    (e) => e.code === "STEP_FAILED" && e.message === "suspend failed"
  );
  assert.equal(ran, false);
  assert.equal(ps.calls.some((c) => c[0] === "resumeHistory"), false);
});

test("runStep executeAsModal rejects with number 9: MODAL_BUSY, message kept", async () => {
  const err = new Error("host is in a modal state");
  err.number = 9;
  const ps = makeStub({ modalReject: err });
  await assert.rejects(
    runStep(ps, "Do Thing", 7, async () => "x"),
    (e) => e instanceof Error && e.code === "MODAL_BUSY" && e.message === "host is in a modal state"
  );
});

test("runStep executeAsModal rejects otherwise: MODAL_FAILED, message kept", async () => {
  const ps = makeStub({ modalReject: new Error("weird") });
  await assert.rejects(
    runStep(ps, "Do Thing", 7, async () => "x"),
    (e) => e.code === "MODAL_FAILED" && e.message === "weird"
  );
});

test("runRead: modal with same options, never suspends history", async () => {
  const ps = makeStub();
  const out = await runRead(ps, "Do Thing", async (ctx) => {
    assert.ok(ctx.hostControl);
    return 5;
  });
  assert.equal(out, 5);
  assert.deepEqual(ps.calls, [["executeAsModal", MODAL_OPTS]]);
});

test("runRead fn throws: rejects with same code and message, no history calls", async () => {
  const ps = makeStub();
  await assert.rejects(
    runRead(ps, "Do Thing", async () => {
      throw codedError("NO_DOCUMENT", "none open");
    }),
    (e) => e.code === "NO_DOCUMENT" && e.message === "none open"
  );
  assert.deepEqual(ps.calls, [["executeAsModal", MODAL_OPTS]]);
});

test("runRead executeAsModal rejects with number 9: MODAL_BUSY", async () => {
  const err = new Error("busy");
  err.number = 9;
  const ps = makeStub({ modalReject: err });
  await assert.rejects(runRead(ps, "R", async () => 1), (e) => e.code === "MODAL_BUSY" && e.message === "busy");
});

test("bp injects dialogOptions, merges existing _options, passes {} options", async () => {
  const ps = makeStub();
  const a = { _obj: "hide" };
  const b = { _obj: "set", _options: { foo: 1 } };
  const out = await bp(ps, [a, b]);
  assert.deepEqual(out, [{}, {}]);
  const [, descs, options] = ps.calls[0];
  assert.deepEqual(options, {});
  assert.deepEqual(descs, [
    { _obj: "hide", _options: { dialogOptions: "dontDisplay" } },
    { _obj: "set", _options: { foo: 1, dialogOptions: "dontDisplay" } },
  ]);
  // caller's descriptors are not mutated
  assert.deepEqual(a, { _obj: "hide" });
  assert.deepEqual(b, { _obj: "set", _options: { foo: 1 } });
});

test("bp throws BATCHPLAY with step index, descriptor _obj and message of first error", async () => {
  const ps = makeStub({
    batchPlayResult: [{}, { _obj: "error", message: "The object is not available" }, { _obj: "error", message: "second" }],
  });
  await assert.rejects(
    bp(ps, [{ _obj: "select" }, { _obj: "move" }, { _obj: "hide" }]),
    (e) =>
      e instanceof Error &&
      e.code === "BATCHPLAY" &&
      e.message === "batchPlay step 1 (move): The object is not available"
  );
});

test("bp error from inside runStep rolls back and surfaces BATCHPLAY outside the modal", async () => {
  const ps = makeStub({ batchPlayResult: [{ _obj: "error", message: "nope" }] });
  await assert.rejects(
    runStep(ps, "Do Thing", 3, () => bp(ps, [{ _obj: "move" }])),
    (e) => e.code === "BATCHPLAY" && e.message === "batchPlay step 0 (move): nope"
  );
  assert.deepEqual(ps.calls.at(-1), ["resumeHistory", 42, false]);
});

// ---------- runSteps ----------

const { runSteps } = require("../lib/step");

// Distinct suspension ids per document; failSuspendFor makes that document's suspension throw.
function multiStub({ failSuspendFor = null } = {}) {
  const calls = [];
  const ps = {
    calls,
    core: {
      async executeAsModal(fn, options) {
        calls.push(["executeAsModal", options]);
        const ctx = {
          hostControl: {
            async suspendHistory(opts) {
              calls.push(["suspendHistory", opts]);
              if (opts.documentID === failSuspendFor) throw new Error("second suspension refused");
              return opts.documentID * 10;
            },
            async resumeHistory(id, commit) {
              calls.push(["resumeHistory", id, commit]);
            },
          },
        };
        try {
          return await fn(ctx);
        } catch (e) {
          throw new Error(e.message);
        }
      },
    },
  };
  return ps;
}

const STEPS = [{ docId: 1, name: "Claude: a" }, { docId: 2, name: "Claude: b" }];
const history = (ps) => ps.calls.filter((c) => c[0] !== "executeAsModal");

test("runSteps success: one modal, suspends in order, commits in reverse, returns fn's value", async () => {
  const ps = multiStub();
  const value = await runSteps(ps, STEPS, async (ctx) => {
    ps.calls.push(["fn", typeof ctx.hostControl]);
    return { ok: 1 };
  });
  assert.deepEqual(value, { ok: 1 });
  assert.equal(ps.calls.filter((c) => c[0] === "executeAsModal").length, 1);
  assert.deepEqual(ps.calls[0][1], { commandName: "Claude: a", interactive: false, timeOut: 30 });
  assert.deepEqual(history(ps), [
    ["suspendHistory", { documentID: 1, name: "Claude: a" }],
    ["suspendHistory", { documentID: 2, name: "Claude: b" }],
    ["fn", "object"],
    ["resumeHistory", 20, true],
    ["resumeHistory", 10, true],
  ]);
});

test("runSteps failure: rolls back every suspension in reverse and keeps the error code", async () => {
  const ps = multiStub();
  await assert.rejects(
    runSteps(ps, STEPS, async () => {
      throw codedError("BOOM", "fn failed");
    }),
    (e) => e.code === "BOOM" && e.message === "fn failed",
  );
  assert.deepEqual(history(ps).slice(2), [["resumeHistory", 20, false], ["resumeHistory", 10, false]]);
});

test("runSteps: a refused second suspension rolls back the first and fn never runs", async () => {
  const ps = multiStub({ failSuspendFor: 2 });
  let ran = false;
  await assert.rejects(
    runSteps(ps, STEPS, async () => {
      ran = true;
    }),
    (e) => e.code === "STEP_FAILED" && /second suspension/.test(e.message),
  );
  assert.equal(ran, false);
  assert.deepEqual(history(ps).slice(2), [["resumeHistory", 10, false]]);
});

test("runScratch success: suspends, always rolls back, returns fn's value", async () => {
  const ps = makeStub();
  const v = await runScratch(ps, "Compare", 7, async () => "pixels");
  assert.equal(v, "pixels");
  assert.deepEqual(ps.calls.filter((c) => c[0] !== "executeAsModal"), [
    ["suspendHistory", { documentID: 7, name: "Compare" }],
    ["resumeHistory", 42, false],
  ]);
});

test("runScratch fn throws: rolls back and keeps the error code", async () => {
  const ps = makeStub();
  await assert.rejects(
    runScratch(ps, "Compare", 7, async () => {
      throw codedError("NO_LAYER", "gone");
    }),
    (e) => e.code === "NO_LAYER" && e.message === "gone",
  );
  assert.deepEqual(ps.calls.filter((c) => c[0] === "resumeHistory"), [["resumeHistory", 42, false]]);
});

test("runScratch: a failed rollback after success is an error; fn's own error wins over it", async () => {
  const ps = makeStub({ resumeThrows: true });
  await assert.rejects(runScratch(ps, "Compare", 7, async () => 1), (e) => e.code === "STEP_FAILED" && /resume failed/.test(e.message));
  await assert.rejects(
    runScratch(ps, "Compare", 7, async () => {
      throw codedError("X", "first");
    }),
    (e) => e.code === "X",
  );
});

test("runScratch suspendHistory throws: fn never runs, no resume", async () => {
  const ps = makeStub({ suspendThrows: true });
  let ran = false;
  await assert.rejects(runScratch(ps, "Compare", 7, async () => (ran = true)), /suspend failed/);
  assert.equal(ran, false);
  assert.equal(ps.calls.filter((c) => c[0] === "resumeHistory").length, 0);
});
