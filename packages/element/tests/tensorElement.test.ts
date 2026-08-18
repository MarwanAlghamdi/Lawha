import { parseDims } from "../src/tensorElement";

describe("parseDims", () => {
  it("reads the separators people actually type", () => {
    expect(parseDims("64x32x32")).toEqual([64, 32, 32]);
    expect(parseDims("64, 32, 32")).toEqual([64, 32, 32]);
    expect(parseDims("64 × 32 × 32")).toEqual([64, 32, 32]);
    expect(parseDims("  128 16 8 ")).toEqual([128, 16, 8]);
  });

  it("keeps a two-dimensional shape two-dimensional", () => {
    expect(parseDims("28 x 28")).toEqual([28, 28]);
  });

  it("drops values that would collapse a face rather than accepting them", () => {
    expect(parseDims("64 x 0 x 32")).toEqual([64, 32]);
    expect(parseDims("-8 x 16")).toEqual([8, 16]);
  });

  it("returns nothing for a draft with no numbers, so callers can keep the old shape", () => {
    expect(parseDims("")).toEqual([]);
    expect(parseDims("batch x channels")).toEqual([]);
  });
});
