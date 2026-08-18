import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { describe, expect, it } from "vitest";

import { LAWHA_KEY } from "../table/tableModel";

import {
  DEFAULT_SNIPPET,
  buildCodeBlock,
  findCodeElement,
  isCodeElement,
  readCodeTag,
  renderCode,
} from "./codeBuild";
import { AUTO, LANGUAGES, highlight, languageLabel } from "./codeHighlight";
import { THEME, buildCodeSvg, svgToDataUrl } from "./codeSvg";

describe("highlight", () => {
  it("colours keywords and strings differently from plain text", () => {
    const result = highlight('const x = "hi";', "javascript");
    const scopes = new Set(
      result.lines
        .flat()
        .map((run) => run.scope)
        .filter(Boolean),
    );

    expect(scopes.has("keyword")).toBe(true);
    expect(scopes.has("string")).toBe(true);
  });

  it("preserves the source text exactly", () => {
    // Colour must never change what the code says.
    const source = 'if (a < b && c > d) { return "x"; }';
    const joined = highlight(source, "javascript")
      .lines.map((line) => line.map((run) => run.text).join(""))
      .join("\n");

    expect(joined).toBe(source);
  });

  it("keeps one line per line", () => {
    const source = "a = 1\nb = 2\nc = 3";
    expect(highlight(source, "python").lines).toHaveLength(3);
  });

  it("splits a run that straddles a newline", () => {
    // A block comment is one highlight.js span covering several lines; the line
    // model has to break it apart or every following line is misplaced.
    const result = highlight("/* one\ntwo\nthree */\nx", "javascript");
    expect(result.lines).toHaveLength(4);
    expect(result.lines[3]!.map((r) => r.text).join("")).toBe("x");
  });

  it("keeps blank lines as empty lines", () => {
    expect(highlight("a = 1\n\nb = 2", "python").lines).toHaveLength(3);
  });

  it("normalises CRLF", () => {
    expect(highlight("a = 1\r\nb = 2", "python").lines).toHaveLength(2);
  });

  it("detects the language when asked to", () => {
    const result = highlight("def add(a, b):\n    return a + b\n", AUTO);
    expect(result.detected).toBe(true);
    expect(result.language).not.toBe("plaintext");
  });

  it("does not claim detection when the language was chosen", () => {
    expect(highlight("x = 1", "python").detected).toBe(false);
  });

  it("degrades to plain text rather than throwing", () => {
    const result = highlight("<<< not really code >>>", "sql");
    expect(
      result.lines
        .flat()
        .map((r) => r.text)
        .join(""),
    ).toContain("not really");
  });

  it("labels every offered language", () => {
    for (const language of LANGUAGES) {
      expect(languageLabel(language.id)).toBe(language.label);
    }
  });
});

describe("buildCodeSvg", () => {
  it("produces a self-contained svg", () => {
    const { svg } = buildCodeSvg(highlight("x = 1", "python"));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("escapes markup in the source so it cannot break the svg", () => {
    // The whole document is text we assembled; an unescaped angle bracket in the
    // snippet would end an element early and produce a blank card.
    const { svg } = buildCodeSvg(highlight("a < b && c > d", "javascript"));
    expect(svg).not.toContain("a < b");
    expect(svg).toContain("&lt;");
    expect(svg).toContain("&amp;");
  });

  it("grows with the number of lines", () => {
    const one = buildCodeSvg(highlight("a", "python"));
    const many = buildCodeSvg(highlight("a\nb\nc\nd\ne", "python"));
    expect(many.height).toBeGreaterThan(one.height);
  });

  it("grows with the longest line", () => {
    const narrow = buildCodeSvg(highlight("a = 1", "python"));
    const wide = buildCodeSvg(highlight(`a = ${"x".repeat(120)}`, "python"));
    expect(wide.width).toBeGreaterThan(narrow.width);
  });

  it("renders an empty snippet as a card rather than a sliver", () => {
    const { height, svg } = buildCodeSvg(highlight("", AUTO));
    expect(height).toBeGreaterThan(40);
    expect(svg).toContain("<svg");
  });

  it("pins every run's width, so fonts cannot make runs drift", () => {
    const { svg } = buildCodeSvg(highlight("const x = 1", "javascript"));
    expect(svg).toContain('lengthAdjust="spacingAndGlyphs"');
    expect(svg).toContain("textLength=");
  });

  it("shows line numbers by default and drops them on request", () => {
    const withNumbers = buildCodeSvg(highlight("a\nb", "python"));
    const without = buildCodeSvg(highlight("a\nb", "python"), {
      showLineNumbers: false,
    });
    expect(without.width).toBeLessThan(withNumbers.width);
  });

  it("names the language in the header", () => {
    const { svg } = buildCodeSvg(highlight("SELECT 1", "sql"));
    expect(svg).toContain("SQL");
  });

  it("uses the dark palette whatever the board theme is", () => {
    const { svg } = buildCodeSvg(highlight("x = 1", "python"));
    expect(svg).toContain(THEME.background);
  });
});

describe("svgToDataUrl", () => {
  it("survives non-latin text, which base64 would not", () => {
    const { svg } = buildCodeSvg(highlight('s = "مرحبا"', "python"));
    expect(() => svgToDataUrl(svg)).not.toThrow();
    expect(svgToDataUrl(svg).startsWith("data:image/svg+xml,")).toBe(true);
  });
});

describe("renderCode", () => {
  it("gives identical source the same file id, so nothing re-uploads", () => {
    const a = renderCode("x = 1", "python");
    const b = renderCode("x = 1", "python");
    expect(a.file.id).toBe(b.file.id);
  });

  it("gives different source a different file id", () => {
    expect(renderCode("x = 1", "python").file.id).not.toBe(
      renderCode("x = 2", "python").file.id,
    );
  });

  it("marks the file as svg", () => {
    expect(renderCode("x = 1", "python").file.mimeType).toBe("image/svg+xml");
  });
});

describe("buildCodeBlock", () => {
  it("is a single image element", () => {
    const { elements } = buildCodeBlock({ x: 0, y: 0 });
    expect(elements).toHaveLength(1);
    expect(elements[0]!.type).toBe("image");
  });

  it("carries the source, not just the picture", () => {
    const { elements } = buildCodeBlock({ x: 0, y: 0, source: "x = 41 + 1" });
    const tag = readCodeTag(elements[0]!)!;

    expect(tag.source).toBe("x = 41 + 1");
    expect(tag.language).toBe(AUTO);
  });

  it("points the element at the file it built", () => {
    const { elements, file } = buildCodeBlock({ x: 0, y: 0 });
    expect((elements[0] as { fileId: string }).fileId).toBe(file.id);
  });

  it("sizes the element to the rendered card", () => {
    const short = buildCodeBlock({ x: 0, y: 0, source: "a" });
    const tall = buildCodeBlock({ x: 0, y: 0, source: "a\nb\nc\nd\ne\nf" });
    expect(tall.elements[0]!.height).toBeGreaterThan(short.elements[0]!.height);
  });

  it("survives restore with its source intact", () => {
    // The picture is derived and could be rebuilt; the source could not.
    const { elements, codeId } = buildCodeBlock({
      x: 0,
      y: 0,
      source: DEFAULT_SNIPPET,
      language: "python",
    });
    const restored = restoreElements(
      JSON.parse(JSON.stringify(elements)),
      null,
    );

    expect(restored).toHaveLength(1);
    expect(restored[0]!.type).toBe("image");
    expect(readCodeTag(restored[0]!)!.source).toBe(DEFAULT_SNIPPET);
    expect(findCodeElement(restored, codeId)).not.toBeNull();
  });

  it("is recognised as a code block, and a bare image is not", () => {
    const { elements } = buildCodeBlock({ x: 0, y: 0 });
    expect(isCodeElement(elements[0]!)).toBe(true);

    const bare = { ...elements[0]!, customData: undefined };
    expect(isCodeElement(bare)).toBe(false);
  });

  it("ignores a malformed tag rather than throwing", () => {
    const { elements } = buildCodeBlock({ x: 0, y: 0 });
    const broken = {
      ...elements[0]!,
      customData: { [LAWHA_KEY]: { kind: "code" } },
    };
    expect(readCodeTag(broken)).toBeNull();
  });
});
