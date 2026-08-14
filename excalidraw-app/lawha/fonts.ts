/**
 * Lawha's typefaces, self-hosted via @fontsource.
 *
 * Loaded from TypeScript rather than SCSS for two reasons:
 *  - Sass cannot `@use` these plain-CSS files (their filenames, e.g. "400.css",
 *    are not valid Sass namespaces), and `@import` of a .css file emits a
 *    runtime `@import url(...)` instead of inlining it.
 *  - Vite resolves and fingerprints them natively from here.
 *
 * They must NOT be added to packages/excalidraw/fonts/fonts.css: that file's
 * contents are string-replaced at build time by
 * scripts/woff2/woff2-vite-plugins.js, so anything placed there works in dev
 * and silently vanishes from production builds.
 *
 * Self-hosted rather than fonts.googleapis.com because Lawha is a LAN-first,
 * offline-capable product: a third-party font origin would block first paint
 * offline and leak board usage to another host.
 */

// UI typeface.
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";

// Every meta / technical / label string. A semantic role, not decoration.
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

// Used only for the two-glyph brand lockup (ل / لوحة) — branding, not
// localisation. The app itself is English-only and left-to-right.
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";

// A single on-canvas annotation, so it may arrive late without harm.
import "@fontsource/caveat/500.css";
