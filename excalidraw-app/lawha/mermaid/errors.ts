/**
 * LAWHA: failures the Mermaid converter can report, as types rather than
 * strings, because the caller does genuinely different things with each.
 *
 * `UnsupportedDiagramError` is not a failure of ours — it means "this is a
 * valid diagram of a kind we do not convert natively", and the honest response
 * is to fall back to the image path rather than show the user an error.
 */

/** A diagram we do not convert natively. The caller should fall back. */
export class UnsupportedDiagramError extends Error {
  constructor(readonly diagramType: string) {
    super(`Lawha does not convert "${diagramType}" natively`);
    this.name = "UnsupportedDiagramError";
  }
}

/**
 * Mermaid could not parse the source.
 *
 * `line`/`column` come from mermaid's own `error.hash`, which is what lets the
 * dialog point at the offending line instead of printing a parser dump.
 */
export class MermaidParseError extends Error {
  readonly line: number | null;
  readonly column: number | null;

  constructor(
    message: string,
    hash?: { line?: number; loc?: { first_column?: number } },
  ) {
    super(message);
    this.name = "MermaidParseError";
    // mermaid's `hash.line` is 0-based; everything a person reads is 1-based.
    this.line = typeof hash?.line === "number" ? hash.line + 1 : null;
    this.column =
      typeof hash?.loc?.first_column === "number"
        ? hash.loc.first_column
        : null;
  }
}

/**
 * The API surface we depend on has moved.
 *
 * We read `diagram.db` (undocumented) through `mermaidAPI.getDiagramFromText`
 * (deprecated). A mermaid upgrade that changes either should fail here, loudly
 * and immediately, rather than produce a diagram that is quietly missing half
 * its nodes.
 */
export class MermaidApiDriftError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `The installed mermaid does not expose: ${missing.join(", ")}. ` +
        `Lawha's converter is pinned to this API surface — see docs/adr/0028.`,
    );
    this.name = "MermaidApiDriftError";
  }
}
