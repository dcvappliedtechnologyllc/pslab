import { describe, expect, it } from "vitest";
import { parseFrame } from "../src/protocol.js";

const layer = {
  id: 1, name: "Background", kind: "pixel", visible: true, opacity: 100,
  blend: "normal", clipped: false, hasMask: false, children: [],
};
const doc = {
  id: 7, name: "a.psd", width: 100, height: 50, ppi: 72, profile: "sRGB",
  bits: 8, activeLayerId: 1, layers: [layer],
};

describe("parseFrame", () => {
  it("accepts hello", () => {
    const f = parseFrame(JSON.stringify({ type: "hello", plugin: "pslab", version: "0.1.0", ps: "27.11.0" }));
    expect(f.type).toBe("hello");
  });
  it("accepts request", () => {
    const f = parseFrame(JSON.stringify({ type: "request", id: "r-17", action: "add_adjustment", args: { a: 1 } }));
    expect(f.type).toBe("request");
  });
  it("accepts ok response with doc", () => {
    const f = parseFrame(JSON.stringify({ type: "response", id: "r-17", ok: true, result: { x: 1 }, doc }));
    expect(f.type).toBe("response");
  });
  it("accepts ok response with null doc", () => {
    expect(parseFrame(JSON.stringify({ type: "response", id: "r-1", ok: true, result: null, doc: null })).type).toBe("response");
  });
  it("accepts error response", () => {
    const f = parseFrame(JSON.stringify({ type: "response", id: "r-17", ok: false, error: { message: "no", code: "NO_DOCUMENT" } }));
    expect(f.type).toBe("response");
  });
  it("accepts ping and pong", () => {
    expect(parseFrame('{"type":"ping"}').type).toBe("ping");
    expect(parseFrame('{"type":"pong"}').type).toBe("pong");
  });
  it("rejects request missing id", () => {
    expect(() => parseFrame('{"type":"request"}')).toThrow();
  });
  it("rejects response with both ok:true and error", () => {
    expect(() => parseFrame(JSON.stringify({
      type: "response", id: "r-1", ok: true, result: {}, doc: null,
      error: { message: "x", code: "Y" },
    }))).toThrow();
  });
  it("rejects an ok response whose doc or nested layer has a wrong field type", () => {
    const frame = (d: unknown) => JSON.stringify({ type: "response", id: "r-1", ok: true, result: null, doc: d });
    expect(() => parseFrame(frame({ ...doc, bits: null }))).toThrow(/bits/);
    const nested = { ...layer, id: 2, kind: "group", children: [{ ...layer, id: 3, hasMask: "no" }] };
    expect(() => parseFrame(frame({ ...doc, layers: [nested] }))).toThrow(/hasMask/);
    expect(parseFrame(frame({ ...doc, layers: [{ ...nested, children: [{ ...layer, id: 3 }] }] })).type).toBe("response");
  });
  it("rejects invalid JSON", () => {
    expect(() => parseFrame("not json")).toThrow();
  });
});
