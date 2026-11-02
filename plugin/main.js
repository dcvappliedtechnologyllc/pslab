// Panel entry: WebSocket client to the pslab server, request dispatch, reconnect.
const { makePs, pluginVersion, hostVersion } = require("./lib/ps");
const { docSummary } = require("./lib/doc");
const { createDispatcher, errorFrame } = require("./lib/dispatch");
const dev = require("./lib/actions/dev");
const actions = require("./lib/actions/index");

const DEFAULT_PORT = 9777;
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

let ps = null;
let dispatch = null;

const el = {
  status: document.getElementById("status"),
  port: document.getElementById("port"),
  toggle: document.getElementById("toggle"),
  autoconnect: document.getElementById("autoconnect"),
  error: document.getElementById("error"),
};

let socket = null;
let wantConnected = false;
let retryTimer = null;
let retryDelay = MIN_DELAY_MS;

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStatus(text) {
  el.status.textContent = text;
  el.toggle.textContent = wantConnected ? "Disconnect" : "Connect";
}

function setError(text) {
  el.error.textContent = text ? `Last error: ${text}` : "";
}

function readPort() {
  const port = Number(el.port.value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function send(frame) {
  try {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(frame));
  } catch (e) {
    setError(String((e && e.message) || e));
  }
}

function onMessage(event) {
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    setError("server sent a frame that is not JSON");
    return;
  }
  if (!frame || typeof frame !== "object") return;
  if (frame.type === "ping") {
    send({ type: "pong" });
  } else if (frame.type === "request" && typeof frame.id === "string") {
    if (!dispatch) {
      send(errorFrame(frame.id, "PLUGIN_ERROR", "The plugin did not finish starting"));
      return;
    }
    dispatch(frame).then(send, (e) => {
      send(errorFrame(frame.id, "PLUGIN_ERROR", String((e && e.message) || e)));
    });
  }
}

function scheduleReconnect() {
  if (!wantConnected || retryTimer) return;
  setStatus("Connecting…");
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, MAX_DELAY_MS);
}

function connect() {
  if (!wantConnected || socket) return;
  const port = readPort();
  if (!port) {
    wantConnected = false;
    setStatus("Disconnected");
    setError("port must be a whole number from 1 to 65535");
    return;
  }
  const url = `ws://localhost:${port}`;
  setStatus("Connecting…");
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    setError(String((e && e.message) || e));
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    retryDelay = MIN_DELAY_MS;
    setError("");
    setStatus(`Connected to ${url}`);
    const psVersion = hostVersion();
    send({ type: "hello", plugin: "pslab", version: pluginVersion(), ps: psVersion });
  };
  ws.onmessage = (event) => {
    if (socket !== ws) return;
    onMessage(event);
  };
  ws.onerror = () => {
    if (socket !== ws) return;
    setError(`could not reach ${url}`);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    if (wantConnected) scheduleReconnect();
    else setStatus("Disconnected");
  };
}

function disconnect() {
  wantConnected = false;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelay = MIN_DELAY_MS;
  const ws = socket;
  socket = null;
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  setStatus("Disconnected");
}

function init() {
  ps = makePs();
  dispatch = createDispatcher(ps, actions, { docSummary, onError: setError });
  // The event recorder is a dev aid: if its listener cannot be added, the
  // panel still connects.
  const recorderFailed = (e) => setError(`event recorder unavailable: ${String((e && e.message) || e)}`);
  try {
    Promise.resolve(dev.start(ps)).catch(recorderFailed);
  } catch (e) {
    recorderFailed(e);
  }
  const savedPort = load("pslab.port");
  el.port.value = String(savedPort || DEFAULT_PORT);
  el.autoconnect.checked = load("pslab.autoconnect") === "true";

  el.port.addEventListener("change", () => {
    if (readPort()) store("pslab.port", String(readPort()));
  });
  el.autoconnect.addEventListener("change", () => {
    store("pslab.autoconnect", el.autoconnect.checked ? "true" : "false");
  });
  el.toggle.addEventListener("click", () => {
    if (wantConnected) {
      disconnect();
    } else {
      wantConnected = true;
      retryDelay = MIN_DELAY_MS;
      setError("");
      if (readPort()) store("pslab.port", String(readPort()));
      connect();
    }
  });

  setStatus("Disconnected");
  if (el.autoconnect.checked) {
    wantConnected = true;
    connect();
  }
}

try {
  init();
} catch (e) {
  try {
    el.error.textContent = `Last error: ${String((e && e.message) || e)}`;
  } catch {}
}
