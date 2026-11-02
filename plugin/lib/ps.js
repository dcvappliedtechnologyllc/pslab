// The only file that touches the Photoshop and UXP modules. Everything else receives `ps`.
function makePs() {
  const photoshop = require("photoshop");
  const uxp = require("uxp");
  return {
    app: photoshop.app,
    core: photoshop.core,
    action: photoshop.action,
    imaging: photoshop.imaging,
    constants: photoshop.constants,
    fs: uxp.storage.localFileSystem,
  };
}

function hostVersion() {
  try {
    const h = require("uxp").host;
    return String((h && h.version) || "unknown");
  } catch {
    return "unknown";
  }
}

function pluginVersion() {
  try {
    return String(require("uxp").versions.plugin || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

module.exports = { makePs, pluginVersion, hostVersion };
