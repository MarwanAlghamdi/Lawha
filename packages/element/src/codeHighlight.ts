/**
 * Turning source text into coloured runs.
 *
 * highlight.js is used rather than the CodeMirror stack the editor already
 * bundles, for one reason: `highlightAuto`. Lezer grammars parse a language you
 * have already named, and naming it is exactly what someone pasting a snippet on
 * a whiteboard does not want to do. Only the core plus a curated language set is
 * registered — the full library is ~190 grammars, which both bloats the bundle
 * and makes detection worse by giving it far more candidates to score.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * The languages offered, in the order the picker shows them.
 *
 * `xml` covers HTML, which is what people actually call it — the label carries
 * the familiar name while the id stays the one highlight.js knows.
 */
export const LANGUAGES = [
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "python", label: "Python" },
  { id: "java", label: "Java" },
  { id: "go", label: "Go" },
  { id: "rust", label: "Rust" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "csharp", label: "C#" },
  { id: "php", label: "PHP" },
  { id: "ruby", label: "Ruby" },
  { id: "sql", label: "SQL" },
  { id: "bash", label: "Shell" },
  { id: "json", label: "JSON" },
  { id: "yaml", label: "YAML" },
  { id: "xml", label: "HTML / XML" },
  { id: "css", label: "CSS" },
  { id: "markdown", label: "Markdown" },
  { id: "dockerfile", label: "Dockerfile" },
  { id: "diff", label: "Diff" },
] as const;

export type LanguageId = typeof LANGUAGES[number]["id"];

/** `auto` means "detect on every render", and is the default for a new block. */
export const AUTO = "auto";
export type LanguageChoice = LanguageId | typeof AUTO;

const REGISTRY: Record<string, unknown> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  java,
  javascript,
  json,
  markdown,
  php,
  python,
  ruby,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

let registered = false;

/** Registered once, lazily — the grammars are only needed if a block exists. */
const ensureRegistered = () => {
  if (registered) {
    return;
  }
  for (const [name, language] of Object.entries(REGISTRY)) {
    hljs.registerLanguage(name, language as never);
  }
  hljs.configure({ classPrefix: "hljs-" });
  registered = true;
};

export const languageLabel = (id: string): string =>
  LANGUAGES.find((language) => language.id === id)?.label ?? id;

/** One coloured span of text within a line. */
export interface Run {
  text: string;
  /** highlight.js scope, e.g. `keyword`, `string`. Null is plain text. */
  scope: string | null;
}

export interface Highlighted {
  /** The language actually used, after detection. */
  language: LanguageId | "plaintext";
  /** Whether that language was detected rather than chosen. */
  detected: boolean;
  lines: Run[][];
}

/**
 * Split highlight.js's HTML into lines of runs.
 *
 * Parsing the emitted HTML rather than using the tokeniser directly, because
 * `highlightAuto` only exposes its result as HTML — and doing it with the DOM
 * rather than a regular expression, since the payload contains escaped source
 * text that a regular expression would happily mangle. `DOMParser` is the same
 * thing the browser would do with it anyway.
 *
 * Nested scopes collapse to the innermost one. A run inside
 * `<span class="hljs-string">` inside `<span class="hljs-meta">` is coloured as
 * a string, which is what every editor does and what a reader expects.
 */
const parseHighlightedHtml = (html: string): Run[][] => {
  const doc = new DOMParser().parseFromString(
    `<div id="root">${html}</div>`,
    "text/html",
  );
  const root = doc.getElementById("root");
  const lines: Run[][] = [[]];

  const push = (text: string, scope: string | null) => {
    // A run may straddle newlines — a block comment, a template literal — so
    // splitting here is what keeps the line model true.
    const parts = text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      if (part.length > 0) {
        lines[lines.length - 1]!.push({ text: part, scope });
      }
    });
  };

  const walk = (node: Node, scope: string | null) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        push(child.textContent ?? "", scope);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as Element;
        const own = Array.from(element.classList)
          .find((name) => name.startsWith("hljs-"))
          ?.slice("hljs-".length);
        walk(element, own ?? scope);
      }
    }
  };

  if (root) {
    walk(root, null);
  }
  return lines;
};

/**
 * Highlight a snippet, detecting the language when asked to.
 *
 * Never throws. A grammar that fails on malformed input, or a language nobody
 * registered, degrades to plain uncoloured text — a code block that renders
 * without colour is a smaller failure than one that does not render.
 */
export const highlight = (
  source: string,
  language: LanguageChoice,
): Highlighted => {
  ensureRegistered();
  const text = source.replace(/\r\n/g, "\n");

  try {
    if (language === AUTO) {
      const result = hljs.highlightAuto(text, Object.keys(REGISTRY));
      return {
        language: (result.language as LanguageId) ?? "plaintext",
        detected: true,
        lines: parseHighlightedHtml(result.value),
      };
    }
    const result = hljs.highlight(text, {
      language,
      ignoreIllegals: true,
    });
    return {
      language,
      detected: false,
      lines: parseHighlightedHtml(result.value),
    };
  } catch {
    return {
      language: "plaintext",
      detected: language === AUTO,
      lines: text
        .split("\n")
        .map((line) => (line ? [{ text: line, scope: null }] : [])),
    };
  }
};
