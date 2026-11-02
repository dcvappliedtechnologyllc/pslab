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

// Returns (frame) => Promise<response frame>. The promise never rejects.
// opts.docSummary(ps, doc) builds the summary sent with every ok response;
// opts.onError(message) hears about a summary that could not be built.
function createDispatcher(ps, actions, { docSummary, onError = () => {} } = {}) {
  async function run(frame) {
    const fn = Object.prototype.hasOwnProperty.call(actions, frame.action) ? actions[frame.action] : null;
    if (!fn) return errorFrame(frame.id, "UNKNOWN_ACTION", `Unknown action: ${frame.action}`);
    let result;
    try {
      result = await fn(ps, frame.args || {});
    } catch (e) {
      return errorFrame(frame.id, (e && e.code) || "PLUGIN_ERROR", text(e));
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
