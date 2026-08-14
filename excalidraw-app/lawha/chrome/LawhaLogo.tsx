import "./LawhaLogo.scss";

interface LawhaLogoProps {
  /** Hides the wordmark, leaving just the tile. */
  compact?: boolean;
}

/**
 * The Lawha brand lockup: a dark tile carrying the Arabic letter ل, then the
 * Latin wordmark and the Arabic one.
 *
 * The Arabic here is branding, not localisation — the interface is
 * English-only and left-to-right, which is why there is no `dir` handling.
 */
export const LawhaLogo = ({ compact }: LawhaLogoProps) => (
  <span className="lw-logo" aria-label="Lawha" role="img">
    <span className="lw-logo__tile" aria-hidden="true">
      ل
    </span>
    {compact ? null : (
      <>
        <span className="lw-logo__wordmark" aria-hidden="true">
          Lawha
        </span>
        <span className="lw-logo__arabic" aria-hidden="true">
          لوحة
        </span>
      </>
    )}
  </span>
);
