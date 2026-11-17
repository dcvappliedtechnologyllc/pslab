// Dev tooling: records every Photoshop action event so batchPlay descriptors can be discovered.
const MAX_EVENTS = 500;
const buffer = [];
let started = false;
let modal = { tool: null, dialog: null };

const enterOrExit = (descriptor) => {
  const st = descriptor && descriptor.state;
  const v = st && typeof st === "object" ? st._value : st;
  return v === "enter" || v === "exit" ? v : null;
};

// Pure reducer over Photoshop's modal notifications: toolModalStateChanged
// (crop, transform, text editing; tool.ID is the selected tool) and
// modalStateChanged (dialogs, with a title). Other events leave it unchanged.
function trackModal(state, event, descriptor) {
  const s = state || { tool: null, dialog: null };
  const dir = enterOrExit(descriptor);
  if (!dir) return s;
  if (event === "toolModalStateChanged") {
    const t = descriptor.tool || {};
    return { ...s, tool: dir === "enter" ? String(t.ID || t.title || "tool") : null };
  }
  if (event === "modalStateChanged") {
    return { ...s, dialog: dir === "enter" ? String(descriptor.title || "dialog") : null };
  }
  return s;
}

// "dialog" | "crop" | "text" | "transform" | null.
function classifyModal(state) {
  if (!state) return null;
  if (state.dialog) return "dialog";
  if (!state.tool) return null;
  if (/crop/i.test(state.tool)) return "crop";
  if (/type|txt|text/i.test(state.tool)) return "text";
  return "transform";
}

// What the modal events seen so far say; dev_events clear does not reset it.
function modalHint() {
  return classifyModal(modal);
}

// Returns whatever addNotificationListener returns (a Promise in UXP), so the
// caller can catch an asynchronous failure too.
function start(ps) {
  if (started) return undefined;
  const pending = ps.action.addNotificationListener([{ event: "all" }], (event, descriptor) => {
    modal = trackModal(modal, event, descriptor);
    buffer.push({ event, descriptor, at: Date.now() });
    if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
  });
  started = true;
  return pending;
}

async function dev_events(ps, args = {}) {
  const events = buffer.slice();
  if (args.clear === true) buffer.length = 0;
  return { events };
}

module.exports = { start, dev_events, trackModal, classifyModal, modalHint };
