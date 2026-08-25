/** LAWHA: turning mermaid's label strings into the plain text Excalidraw draws. */

/**
 * Mermaid encodes `#35;`-style HTML entities in labels. Excalidraw text is
 * drawn on a canvas, not parsed as HTML, so they have to be decoded here or
 * the user sees the escape sequence.
 */
export const decodeEntities = (text: string): string =>
  text
    .replace(/#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/#([a-zA-Z]+);/g, (whole, name) => {
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
        semi: ";",
        colon: ":",
        approxequals: "≈",
      };
      return named[name] ?? whole;
    });

/**
 * Flatten a markdown label.
 *
 * Excalidraw text has one font and one weight for the whole element — there
 * are no inline runs — so `**bold**` cannot be honoured. Stripping the markers
 * is strictly better than drawing them, and the caller raises a warning so the
 * loss is stated rather than silent.
 */
export const flattenMarkdown = (text: string): string =>
  text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1");

/** Mermaid uses a literal `<br>` for a line break inside a label. */
export const normaliseBreaks = (text: string): string =>
  text.replace(/<br\s*\/?>/gi, "\n");

export const labelText = (raw: unknown): string =>
  typeof raw === "string" ? normaliseBreaks(decodeEntities(raw)).trim() : "";
