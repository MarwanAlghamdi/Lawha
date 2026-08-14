// define `EXCALIDRAW_ASSET_PATH` as a SSOT
//
// **Lawha serves its own fonts. There is no CDN here, and that is the point.**
//
// Upstream points this at `https://excalidraw.nyc3.cdn.digitaloceanspaces.com/oss/`
// with the deployment's own origin as a fallback, which is right for
// excalidraw.com and wrong for a self-hosted board on somebody's LAN, in three
// separate ways:
//
//   1. **It phones a third party on every page load.** Four `<link rel=preload>`
//      tags plus the `@font-face` sources reach DigitalOcean before anything is
//      drawn, handing over an IP and the fact that this deployment exists. A
//      product whose whole claim is that your boards stay on your machine must
//      not open connections to a CDN to render its own UI.
//   2. **It is slow exactly where it is least affordable.** Measured on the
//      Docker stack: `DOMContentLoaded` at 141ms, `load` at **30,038ms** — four
//      fonts timing out at 30s apiece. `font-display: swap` means text still
//      appears, so this was invisible until something waited for `load`. What
//      waited was the visual-regression suite, whose setup step timed out and
//      could therefore never regenerate a baseline (roadmap known issues 18/29).
//   3. **On a LAN with no route out it is pure cost.** Every font it asks the
//      CDN for is already in the image — 267 woff2 files, including the exact
//      hashed filenames requested. `/fonts/Excalifont/Excalifont-Regular-a88b….woff2`
//      answers 200 with 24,956 bytes from nginx.
//
// So: the deployment's own origin, and nothing else. Restoring the CDN would
// need a reason that outweighs all three.
// Not a *fallback* any more — it is the only source, so it is named for what
// it is. Left as a constant rather than inlined because four preload tags and
// the asset path all have to agree.
const LOCAL_ASSET_PATH = "/";

/**
 * Custom vite plugin for auto-prefixing `EXCALIDRAW_ASSET_PATH` woff2 fonts in `excalidraw-app`.
 *
 * @returns {import("vite").PluginOption}
 */
module.exports.woff2BrowserPlugin = () => {
  let isDev;

  return {
    name: "woff2BrowserPlugin",
    enforce: "pre",
    config(_, { command }) {
      isDev = command === "serve";
    },
    transform(code, id) {
      // using copy / replace as fonts defined in the `.css` don't have to be manually copied over (vite/rollup does this automatically),
      // but at the same time can't be easily prefixed with the `EXCALIDRAW_ASSET_PATH` only for the `excalidraw-app`
      if (!isDev && id.endsWith("/excalidraw/fonts/fonts.css")) {
        return `/* WARN: The following content is generated during excalidraw-app build */

      @font-face {
        font-family: "Assistant";
        src: url(./Assistant-Regular.woff2) format("woff2");
        font-weight: 400;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(./Assistant-Medium.woff2) format("woff2");
        font-weight: 500;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(./Assistant-SemiBold.woff2) format("woff2");
        font-weight: 600;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(./Assistant-Bold.woff2) format("woff2");
        font-weight: 700;
        style: normal;
        display: swap;
      }`;
      }

      if (!isDev && id.endsWith("excalidraw-app/index.html")) {
        return code.replace(
          "<!-- PLACEHOLDER:EXCALIDRAW_APP_FONTS -->",
          `<script>
        // this deployment, and nowhere else — see the note at the top of this
        // file. A string rather than a one-element array because
        // ExcalidrawFontFace handles both and the string says "one place".
        window.EXCALIDRAW_ASSET_PATH = "${LOCAL_ASSET_PATH}";
      </script>

      <!-- Preload all default fonts to avoid swap on init -->
      <link
        rel="preload"
        href="${LOCAL_ASSET_PATH}fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <!-- For Nunito only preload the latin range, which should be good enough for now -->
      <link
        rel="preload"
        href="${LOCAL_ASSET_PATH}fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <link
        rel="preload"
        href="${LOCAL_ASSET_PATH}fonts/Assistant/Assistant-SemiBold.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <link
        rel="preload"
        href="${LOCAL_ASSET_PATH}fonts/ComicShanns/ComicShanns-Regular-279a7b317d12eb88de06167bd672b4b4.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
    `,
        );
      }
    },
  };
};
