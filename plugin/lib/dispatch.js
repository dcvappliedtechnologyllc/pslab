// Request dispatch: one action at a time, in arrival order. Photoshop runs a
// single modal scope at once, so a second executeAsModal while one is open
// would fail with MODAL_BUSY; queueing here keeps concurrent server calls safe.

function errorFrame(id, code, message) {
  return { type: "response", id, ok: false, error: { code, message } };
}

const text = (e) => String((e && e.message) || e);

// The summary describes the document the call targeted (args.doc, or
// args.dst_doc for copy_to), falling back to the active document when the
// id is absent or unknown.
function summaryTarget(ps, args) {
  const wanted = args && (args.doc !== undefined && args.doc !== null ? args.doc : args.dst_doc);
  if (wanted !== undefined && wanted !== null) {
    try {
      const hit = Array.from(ps.app.documents || []).find((d) => d && d.id === wanted);
      if (hit) return hit;
    } catch {}
  }
  try {
    return ps.app.activeDocument || null;
  } catch {
    return null;
  }
}

// Errors a Photoshop modal state (a crop, Free Transform, text editing, a
// dialog) can masquerade as: the layer tree shows "Crop Preview", ids vanish,
// batchPlay or the modal scope fails.
const MODAL_SUSPECT = new Set(["NO_LAYER", "NO_DOCUMENT", "BATCHPLAY", "MODAL_FAILED", "STEP_FAILED", "MODAL_BUSY"]);

// Returns (frame) => Promise<response frame>. The promise never rejects.
// opts.docSummary(ps, doc) builds the summary sent with every ok response;
// opts.onError(message) hears about a summary that could not be built;
// opts.modalState(ps, doc) (optional) is probed once after a MODAL_SUSPECT
// error and, when Photoshop is modal, turns the error into MODAL_BUSY.
function createDispatcher(ps, actions, { docSummary, onError = () => {}, modalState = null } = {}) {
  async function failure(frame, e) {
    const code = (e && e.code) || "PLUGIN_ERROR";
    if (modalState && MODAL_SUSPECT.has(code)) {
      let kind = null;
      try {
        kind = await modalState(ps, summaryTarget(ps, frame.args));
      } catch {}
      if (kind) {
        return errorFrame(
          frame.id,
          "MODAL_BUSY",
          `Photoshop is in a modal state (${kind}); commit or cancel it, then retry (was ${code}: ${text(e)})`,
        );
      }
    }
    return errorFrame(frame.id, code, text(e));
  }

  async function run(frame) {
    const fn = Object.prototype.hasOwnProperty.call(actions, frame.action) ? actions[frame.action] : null;
    if (!fn) return errorFrame(frame.id, "UNKNOWN_ACTION", `Unknown action: ${frame.action}`);
    let result;
    try {
      result = await fn(ps, frame.args || {});
    } catch (e) {
      return failure(frame, e);
    }
    let doc = null;
    try {
      doc = await docSummary(ps, summaryTarget(ps, frame.args));
    } catch (e) {
      doc = null;
      try {
        onError(`document summary failed: ${text(e)}`);
      } catch {}
    }
    return { type: "response", id: frame.id, ok: true, result: result === undefined ? null : result, doc };
  }

  let tail = Promise.resolve();
  return (frame) => {
    const next = tail.then(() => run(frame)).catch((e) => errorFrame(frame.id, "PLUGIN_ERROR", text(e)));
    tail = next;
    return next;
  };
}

module.exports = { createDispatcher, errorFrame };
