import { describe, expect, it } from "vitest";
import type { OcrResult, OcrWord } from "../lib/types";
import { colourText, hexOf, linesLabel, luhn, ocrInside, ocrTable, ocrText, privateBoxes, privateKind } from "./snipText";

/** A line of words, each 10 px per letter, 20 px high, 10 px apart. */
function line(y: number, x0: number, ...texts: string[]) {
  let x = x0;
  const words: OcrWord[] = texts.map((t) => {
    const w = { text: t, x, y, w: t.length * 10, h: 20 };
    x += t.length * 10 + 10;
    return w;
  });
  return { text: texts.join(" "), words };
}
const result = (...lines: ReturnType<typeof line>[]): OcrResult => ({ language: "en-US", lines });

describe("snip text", () => {
  it("reads lines top to bottom with paragraph gaps", () => {
    const r = result(line(100, 0, "second"), line(0, 0, "Hello", "world"), line(26, 0, "again"));
    expect(ocrText(r)).toBe("Hello world\nagain\n\nsecond");
    expect(linesLabel(ocrText(r))).toBe("3 lines");
    expect(linesLabel("one")).toBe("1 line");
  });
  it("puts lines that sit side by side left to right", () => {
    expect(ocrText(result(line(0, 400, "right"), line(2, 0, "left")))).toBe("left\nright");
  });
  it("makes a table: wide gaps split cells, cells line up in columns", () => {
    const r = result(
      { text: "Name Score", words: [...line(0, 0, "Name").words, ...line(0, 200, "Score").words] },
      { text: "Ann Lee 12", words: [...line(30, 0, "Ann", "Lee").words, ...line(30, 200, "12").words] },
      { text: "7", words: line(60, 200, "7").words },
    );
    expect(ocrTable(r)).toBe("Name\tScore\nAnn Lee\t12\n\t7");
  });
  it("keeps only the words inside a box", () => {
    const r = result(line(0, 0, "in", "out"), line(100, 0, "far"));
    expect(ocrText(ocrInside(r, { x: 0, y: 0, w: 25, h: 30 }))).toBe("in");
  });
});

describe("personal details", () => {
  it("knows card numbers by their check digit", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
  });
  it("tells e-mails, phones, cards, IBANs and IPs from plain numbers", () => {
    expect(privateKind("ann@example.com,")).toBe("email");
    expect(privateKind("+1 555 123 4567")).toBe("phone");
    expect(privateKind("(555) 123-4567")).toBe("phone");
    expect(privateKind("4111 1111 1111 1111")).toBe("card");
    expect(privateKind("GB82WEST12345698765432")).toBe("iban");
    expect(privateKind("192.168.1.20")).toBe("ip");
    expect(privateKind("2026")).toBeNull();
    expect(privateKind("1500000")).toBeNull();
    expect(privateKind("hello")).toBeNull();
  });
  it("boxes a phone number written over several words", () => {
    const r = result(line(0, 0, "Call", "+1", "555", "123", "4567", "now"));
    const hits = privateBoxes(r);
    expect(hits.map((h) => h.kind)).toEqual(["phone"]);
    expect(hits[0].box).toEqual({ x: 50, y: 0, w: 150, h: 20 });
  });
});

describe("colours", () => {
  it("writes a colour as HEX, RGB or HSL", () => {
    expect(hexOf(26, 43, 60)).toBe("#1A2B3C");
    expect(colourText(255, 0, 0, "rgb")).toBe("rgb(255, 0, 0)");
    expect(colourText(255, 0, 0, "hsl")).toBe("hsl(0, 100%, 50%)");
    expect(colourText(0, 0, 0, "hsl")).toBe("hsl(0, 0%, 0%)");
  });
});
