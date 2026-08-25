/** LAWHA: every knob and magic number the Mermaid converter has, in one place. */

export interface ConverterOptions {
  /**
   * Degrade every shape Excalidraw has no primitive for to a rectangle.
   *
   * A hexagon or a cylinder is drawn as a closed `line` with `polygon: true`,
   * which reproduces the silhouette exactly — but a line is not in
   * `ExcalidrawBindableElement`, so arrows touching it are geometric rather
   * than bound and it cannot carry a bound label. Turning this on trades the
   * silhouette for arrows that re-route when the node is dragged.
   */
  preferBindableShapes: boolean;
  /** Put every subgraph's members in a shared group. Off: a click selects one node. */
  groupSubgraphs: boolean;
  /** dagre spacing, in scene units. */
  nodeSep: number;
  rankSep: number;
  margin: number;
  /** Label sizing. */
  fontSize: number;
  /** Minimum node box, so a one-character label is still a target you can hit. */
  minNodeWidth: number;
  minNodeHeight: number;
  /** Padding between a label and its node's edge. */
  nodePadding: number;
}

export const DEFAULT_OPTIONS: ConverterOptions = {
  preferBindableShapes: false,
  groupSubgraphs: false,
  nodeSep: 40,
  rankSep: 60,
  margin: 20,
  fontSize: 16,
  minNodeWidth: 60,
  minNodeHeight: 44,
  nodePadding: 14,
};

export const withDefaults = (
  options?: Partial<ConverterOptions>,
): ConverterOptions => ({ ...DEFAULT_OPTIONS, ...options });
