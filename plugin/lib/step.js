// Execution contract for every Photoshop call that needs the modal scope.
// runStep: one named history state per call, rolled back on failure.
// Errors thrown inside executeAsModal lose their type/code at the modal
// boundary, so the modal callback never throws: it returns {error} or
// {value}, and we rethrow a coded Error outside the modal.

const MODAL_TIMEOUT_S = 30;

function toErrorValue(e) {
  return {
    __error: {
      code: (e && e.code) || "STEP_FAILED",
      message: (e && e.message) || String(e),
    },
  };
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function modal(ps, name, body) {
  let out;
  try {
    out = await ps.core.executeAsModal(body, {
      commandName: name,
      interactive: false,
      timeOut: MODAL_TIMEOUT_S,
    });
  } catch (e) {
    throw codedError(e && e.number === 9 ? "MODAL_BUSY" : "MODAL_FAILED", (e && e.message) || String(e));
  }
  if (out && out.__error) throw codedError(out.__error.code, out.__error.message);
  return out ? out.__value : undefined;
}

function runStep(ps, name, docId, fn) {
  return modal(ps, name, async (ctx) => {
    const host = ctx.hostControl;
    let id;
    let committed = false;
    try {
      id = await host.suspendHistory({ documentID: docId, name });
      const value = await fn(ctx);
      await host.resumeHistory(id, true);
      committed = true;
      return { __value: value };
    } catch (e) {
      if (id !== undefined && !committed) {
        try {
          await host.resumeHistory(id, false);
        } catch {
          // the original error wins
        }
      }
      return toErrorValue(e);
    }
  });
}

// Several documents' history in one modal scope: each step {docId, name} is
// suspended in order, fn runs once, then the suspensions are committed in
// reverse order. On any error every open suspension is rolled back in reverse.
// Two concurrent suspensions are verified against live Photoshop in the phase 3 check.
function runSteps(ps, steps, fn) {
  return modal(ps, steps[0].name, async (ctx) => {
    const host = ctx.hostControl;
    const open = [];
    try {
      for (const s of steps) open.push(await host.suspendHistory({ documentID: s.docId, name: s.name }));
      const value = await fn(ctx);
      while (open.length) await host.resumeHistory(open.pop(), true);
      return { __value: value };
    } catch (e) {
      while (open.length) {
        try {
          await host.resumeHistory(open.pop(), false);
        } catch {
          // the original error wins
        }
      }
      return toErrorValue(e);
    }
  });
}

// A scratch step: the suspension is ALWAYS rolled back (resumeHistory false),
// so whatever fn changes (e.g. hiding layers to read a "before" composite)
// leaves no history state and no net change. fn's value is still returned.
function runScratch(ps, name, docId, fn) {
  return modal(ps, name, async (ctx) => {
    const host = ctx.hostControl;
    let id;
    let result;
    try {
      id = await host.suspendHistory({ documentID: docId, name });
      result = { __value: await fn(ctx) };
    } catch (e) {
      result = toErrorValue(e);
    }
    if (id !== undefined) {
      try {
        await host.resumeHistory(id, false);
      } catch (e) {
        // fn's error wins; on success a failed rollback is the error
        if (!result.__error) result = toErrorValue(e);
      }
    }
    return result;
  });
}

function runRead(ps, name, fn) {
  return modal(ps, name, async (ctx) => {
    try {
      return { __value: await fn(ctx) };
    } catch (e) {
      return toErrorValue(e);
    }
  });
}

async function bp(ps, descriptors) {
  const descs = descriptors.map((d) => ({
    ...d,
    _options: { ...(d._options || {}), dialogOptions: "dontDisplay" },
  }));
  const results = await ps.action.batchPlay(descs, {});
  const i = results.findIndex((r) => r && r._obj === "error");
  if (i !== -1) {
    throw codedError("BATCHPLAY", `batchPlay step ${i} (${descs[i]._obj}): ${results[i].message}`);
  }
  return results;
}

module.exports = { runStep, runSteps, runScratch, runRead, bp };
