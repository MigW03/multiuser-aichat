import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sniffImage } from "./image-sniff.ts";

const bytes = (...v: number[]) => Uint8Array.from(v);
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

describe("sniffImage", () => {
  it("knows the four accepted types from their first bytes", () => {
    assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10)), "image/jpeg");
    assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), "image/png");
    assert.equal(sniffImage(ascii("GIF89a\u0001\u0000")), "image/gif");
    assert.equal(sniffImage(ascii("GIF87a\u0001\u0000")), "image/gif");
    assert.equal(sniffImage(Uint8Array.from([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBPVP8 ")])), "image/webp");
  });
  it("refuses everything else, whatever the file claims to be", () => {
    assert.equal(sniffImage(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
    assert.equal(sniffImage(ascii("<html><script>alert(1)</script>")), null);
    assert.equal(sniffImage(ascii("%PDF-1.7")), null);
    assert.equal(sniffImage(Uint8Array.from([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVEfmt ")])), null); // RIFF, but audio
    assert.equal(sniffImage(new Uint8Array(0)), null);
    assert.equal(sniffImage(bytes(0xff, 0xd8)), null);
  });
});
