import { LawhaPanel } from "../chrome/LawhaPanel";

import "./LawhaAIMenu.scss";

interface LawhaAIMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
}

interface AIFeature {
  name: string;
  blurb: string;
}

/**
 * Everything AI, in one place.
 *
 * Upstream scatters these: text-to-diagram hides in the toolbar's overflow
 * dropdown, wireframe-to-code appears only once a frame is selected, and both
 * call `VITE_APP_AI_BACKEND` — Excalidraw's hosted service, which a self-hosted
 * Lawha has no access to and would not want to send drawings to anyway.
 *
 * So they are gathered here and marked unavailable rather than left as live
 * buttons that fail on click.
 */
const FEATURES: readonly AIFeature[] = [
  {
    name: "Draw by chat",
    blurb: "Describe a diagram and have it drawn onto the canvas.",
  },
  {
    name: "Text to diagram",
    blurb: "Turn a Mermaid definition or a description into shapes.",
  },
  {
    name: "Wireframe to code",
    blurb: "Turn a frame of boxes and labels into working HTML.",
  },
  {
    name: "Summarise this board",
    blurb: "Read a board back as notes, for whoever missed the session.",
  },
];

const SoonBadge = () => (
  <span className="lw-chip lw-chip--purple lw-ai__badge">soon</span>
);

const AIBody = ({ onClose }: { onClose: () => void }) => (
  <>
    <div className="lw-ai__header">
      <span className="lw-ai__heading">AI</span>
      <SoonBadge />
      <div className="lw-ai__spacer" />
      <button
        type="button"
        className="lw-ai__close"
        onClick={onClose}
        aria-label="Close AI panel"
      >
        ×
      </button>
    </div>

    <p className="lw-ai__blurb">
      None of this is switched on yet. When it is, it will run against a model
      you point Lawha at — nothing leaves your infrastructure by default.
    </p>

    <ul className="lw-ai__list">
      {FEATURES.map((feature) => (
        <li key={feature.name}>
          {/*
            A real disabled button, not a styled div: `disabled` is what tells
            assistive tech the row is unavailable, and it is what stops the row
            taking focus in the tab order for no reason.
          */}
          <button type="button" className="lw-ai__item" disabled>
            <span className="lw-ai__item-head">
              <span className="lw-ai__item-name">{feature.name}</span>
              <SoonBadge />
            </span>
            <span className="lw-ai__item-blurb">{feature.blurb}</span>
          </button>
        </li>
      ))}
    </ul>
  </>
);

export const LawhaAIMenu = ({
  open,
  onOpenChange,
  compact,
}: LawhaAIMenuProps) => (
  <LawhaPanel
    open={open}
    onOpenChange={onOpenChange}
    className="lw-ai"
    ariaLabel="AI features"
    trigger={(triggerProps) => (
      <button
        {...triggerProps}
        type="button"
        className="lw-btn lw-ai-trigger"
        aria-label="AI features — coming soon"
      >
        <span aria-hidden="true" className="lw-ai-trigger__glyph" />
        {compact ? null : <span>AI</span>}
        <SoonBadge />
      </button>
    )}
  >
    <AIBody onClose={() => onOpenChange(false)} />
  </LawhaPanel>
);
