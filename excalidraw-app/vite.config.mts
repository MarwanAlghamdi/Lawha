import fs from "fs";
import path from "path";

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import svgrPlugin from "vite-plugin-svgr";
import { ViteEjsPlugin } from "vite-plugin-ejs";
import { VitePWA } from "vite-plugin-pwa";
import checker from "vite-plugin-checker";
import { createHtmlPlugin } from "vite-plugin-html";
import Sitemap from "vite-plugin-sitemap";

import { woff2BrowserPlugin } from "../scripts/woff2/woff2-vite-plugins";
export default defineConfig(({ mode }) => {
  // To load .env variables.
  // The LAWHA_ prefix is included so the dev-proxy target can be configured
  // without exposing it to the client bundle, as a VITE_ name would.
  const envVars = loadEnv(mode, `../`, ["VITE_", "LAWHA_"]);
  // https://vitejs.dev/config/
  return {
    server: {
      port: Number(envVars.VITE_APP_PORT || 3000),
      // open the browser
      open: true,
      // TLS, when a certificate is supplied.
      //
      // This comment used to say a LAN address without it made board creation
      // "fail outright", because every board key was minted with
      // `window.crypto.subtle`. There are no board keys since ADR 0012, and
      // ADR 0018 retired the invariant that claim came from — its title is
      // "the end of invariant 18". `generateBoardId` uses
      // `crypto.getRandomValues`, which is not secure-context-gated, so a
      // board is created fine over plain http.
      //
      // What a LAN address without TLS actually costs is measured in ADR 0018:
      // image ids stop being content hashes (`generateIdFromFile` already
      // falls back to `nanoid(40)`), two clipboard buttons stop working, and
      // boards written before ADR 0012 cannot be decrypted. Worth setting for
      // LAN or tailnet testing; not a prerequisite.
      //
      // Paths are used as given, so absolute ones are safest — a relative path
      // resolves against the Vite root (`excalidraw-app/`), not the repo root.
      https:
        envVars.LAWHA_HTTPS_KEY && envVars.LAWHA_HTTPS_CERT
          ? {
              key: fs.readFileSync(envVars.LAWHA_HTTPS_KEY),
              cert: fs.readFileSync(envVars.LAWHA_HTTPS_CERT),
            }
          : undefined,
      // Newer Vite rejects requests whose Host header it does not recognise,
      // answering a bare "Blocked request" — five words of plain text with
      // nothing to say Vite produced them, so it reads as a broken gateway.
      // Bare IPs and `*.localhost` are exempt; any other NAME must be listed.
      //
      // THIS OPTION IS CURRENTLY INERT, and it is worth knowing before you
      // debug through it: `server.allowedHosts` arrived in Vite 5.4.12 / 6.0.9
      // (CVE-2025-24010) and this repo is pinned to 5.0.12, which has no host
      // check at all — the string "Blocked request" does not appear anywhere in
      // its dist. So today every Host reaches the dev server, `lawha.local`
      // included, and this block is forward-wiring: the day vite is bumped it
      // starts mattering, without a second round of this discovery.
      //
      // Either way the plumbing is right, so
      //
      //     LAWHA_ALLOWED_HOSTS=lawha.local corepack yarn start
      //
      // works now and keeps working after the bump — loadEnv above takes
      // LAWHA_-prefixed names from the process environment as well as from
      // ../.env*. Comma-separated for several; see the README.
      //
      // It matters only when the DEV SERVER is what the gateway points at,
      // which is the narrow case. Normally https://lawha.local reaches the
      // Docker stack on :9002 and nginx never consults this.
      //
      // Two things it does not excuse. It is not permission to expose the dev
      // server over a tunnel — invariant 14, ~885 module requests per cold
      // load, each paying the round trip. And the browser still has to end up
      // on an https origin: a gateway that terminates TLS itself gives you
      // that, one that merely forwards does not, and then LAWHA_HTTPS_KEY /
      // LAWHA_HTTPS_CERT above are what stand between you and a `crypto.subtle
      // is undefined` on the first "New board".
      allowedHosts: envVars.LAWHA_ALLOWED_HOSTS
        ? envVars.LAWHA_ALLOWED_HOSTS.split(",")
            .map((host) => host.trim())
            .filter((host) => host.length > 0)
        : undefined,
      // Proxy lawha-server so the app and API share an origin. That keeps the
      // session cookie first-party (no SameSite=None, no Secure requirement on
      // a plain-HTTP LAN) and avoids CORS preflight entirely.
      proxy: {
        "/api": {
          target: envVars.LAWHA_SERVER_URL || "http://localhost:3002",
          changeOrigin: false,
        },
        "/socket.io": {
          target: envVars.LAWHA_SERVER_URL || "http://localhost:3002",
          changeOrigin: false,
          ws: true,
        },
      },
    },
    // We need to specify the envDir since now there are no
    //more located in parallel with the vite.config.ts file but in parent dir
    envDir: "../",
    resolve: {
      alias: [
        {
          find: /^@excalidraw\/common$/,
          replacement: path.resolve(
            __dirname,
            "../packages/common/src/index.ts",
          ),
        },
        {
          find: /^@excalidraw\/common\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/common/src/$1"),
        },
        {
          find: /^@excalidraw\/element$/,
          replacement: path.resolve(
            __dirname,
            "../packages/element/src/index.ts",
          ),
        },
        {
          find: /^@excalidraw\/element\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/element/src/$1"),
        },
        {
          find: /^@excalidraw\/excalidraw$/,
          replacement: path.resolve(
            __dirname,
            "../packages/excalidraw/index.tsx",
          ),
        },
        {
          find: /^@excalidraw\/excalidraw\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/excalidraw/$1"),
        },
        {
          find: /^@excalidraw\/math$/,
          replacement: path.resolve(__dirname, "../packages/math/src/index.ts"),
        },
        {
          find: /^@excalidraw\/math\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/math/src/$1"),
        },
        {
          find: /^@excalidraw\/utils$/,
          replacement: path.resolve(
            __dirname,
            "../packages/utils/src/index.ts",
          ),
        },
        {
          find: /^@excalidraw\/utils\/(.*?)/,
          replacement: path.resolve(__dirname, "../packages/utils/src/$1"),
        },
        {
          find: /^@excalidraw\/fractional-indexing$/,
          replacement: path.resolve(
            __dirname,
            "../packages/fractional-indexing/src/index.ts",
          ),
        },
        {
          find: /^@excalidraw\/laser-pointer$/,
          replacement: path.resolve(
            __dirname,
            "../packages/laser-pointer/src/index.ts",
          ),
        },
      ],
    },
    build: {
      outDir: "build",
      rollupOptions: {
        output: {
          assetFileNames(chunkInfo) {
            if (chunkInfo?.name?.endsWith(".woff2")) {
              const family = chunkInfo.name.split("-")[0];
              return `fonts/${family}/[name][extname]`;
            }

            return "assets/[name]-[hash][extname]";
          },
          // Creating separate chunk for locales except for en and percentages.json so they
          // can be cached at runtime and not merged with
          // app precache. en.json and percentages.json are needed for first load
          // or fallback hence not clubbing with locales so first load followed by offline mode works fine. This is how CRA used to work too.
          manualChunks(id) {
            if (
              id.includes("packages/excalidraw/locales") &&
              id.match(/en.json|percentages.json/) === null
            ) {
              const index = id.indexOf("locales/");
              // Taking the substring after "locales/"
              return `locales/${id.substring(index + 8)}`;
            }

            if (id.includes("@excalidraw/mermaid-to-excalidraw")) {
              return "mermaid-to-excalidraw";
            }

            if (id.includes("@codemirror/") || id.includes("@lezer/")) {
              return "codemirror.chunk";
            }
          },
        },
      },
      sourcemap: true,
      // don't auto-inline small assets (i.e. fonts hosted on CDN)
      assetsInlineLimit: 0,
    },
    plugins: [
      Sitemap({
        hostname: "https://excalidraw.com",
        outDir: "build",
        changefreq: "monthly",
        // its static in public folder
        generateRobotsTxt: false,
      }),
      woff2BrowserPlugin(),
      react(),
      checker({
        typescript: true,
        eslint:
          envVars.VITE_APP_ENABLE_ESLINT === "false"
            ? undefined
            : { lintCommand: 'eslint "./**/*.{js,ts,tsx}"' },
        overlay: {
          initialIsOpen: envVars.VITE_APP_COLLAPSE_OVERLAY === "false",
          badgeStyle: "margin-bottom: 4rem; margin-left: 1rem",
        },
      }),
      svgrPlugin(),
      ViteEjsPlugin(),
      VitePWA({
        registerType: "autoUpdate",
        devOptions: {
          /* set this flag to true to enable in Development mode */
          enabled: envVars.VITE_APP_ENABLE_PWA === "true",
        },

        workbox: {
          // don't precache fonts, locales and separate chunks
          globIgnores: [
            "fonts.css",
            "**/locales/**",
            "service-worker.js",
            "**/*.chunk-*.js",
            // CodeMirrorEditor can't be assigned a `.chunk` name via
            // manualChunks because Rollup would hoist shared deps (React)
            // via a static import from the main bundle, defeating lazy
            // loading. So we exclude it by name instead.
            "**/CodeMirrorEditor-*.js",
            // The Mermaid text-to-diagram feature (`@excalidraw/mermaid-to-excalidraw`)
            // pulls in ~35 chunks on its own — one per diagram type plus
            // cytoscape, dagre, katex and a lodash-es subset — none of which
            // are needed until someone actually inserts a Mermaid diagram.
            // Precaching them after first paint was real, unwanted traffic on
            // a first visit over a tunnel. The `mermaid-to-excalidraw-*.js`
            // wrapper chunk itself is a genuine static import of the main
            // bundle (small shared bindings live in it) and stays precached;
            // only its lazy, diagram-type-specific dependants are excluded
            // here. Same names as `assets/*.js` in a production build — if
            // mermaid-to-excalidraw's internal chunking changes, re-check
            // `excalidraw-app/build/assets` after a build.
            "**/*Diagram-*.js",
            "**/*-definition-*.js",
            "**/diagram-*.js",
            "**/graph-*.js",
            "**/clone-*.js",
            "**/layout-*.js",
            "**/dagre-*.js",
            "**/treemap-*.js",
            "**/cytoscape.esm-*.js",
            "**/cose-bilkent-*.js",
            "**/katex-*.js",
            "**/_baseUniq-*.js",
            "**/_basePickBy-*.js",
            "**/chunk-*.js",
          ],
          runtimeCaching: [
            {
              urlPattern: new RegExp(".+.woff2"),
              handler: "CacheFirst",
              options: {
                cacheName: "fonts",
                expiration: {
                  maxEntries: 1000,
                  maxAgeSeconds: 60 * 60 * 24 * 90, // 90 days
                },
                cacheableResponse: {
                  // 0 to cache "opaque" responses from cross-origin requests (i.e. CDN)
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: new RegExp("fonts.css"),
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "fonts",
                expiration: {
                  maxEntries: 50,
                },
              },
            },
            {
              urlPattern: new RegExp("locales/[^/]+.js"),
              handler: "CacheFirst",
              options: {
                cacheName: "locales",
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: 60 * 60 * 24 * 30, // <== 30 days
                },
              },
            },
            {
              urlPattern: new RegExp("(.chunk-.+|CodeMirrorEditor-.+)\\.js"),
              handler: "CacheFirst",
              options: {
                cacheName: "chunk",
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: 60 * 60 * 24 * 90, // <== 90 days
                },
              },
            },
          ],
          maximumFileSizeToCacheInBytes: 2.3 * 1024 ** 2, // 2.3MB
        },
        manifest: {
          short_name: "Lawha",
          name: "Lawha",
          description:
            "Lawha is a self-hosted, LAN-first collaborative whiteboard with a hand-drawn feel.",
          icons: [
            {
              src: "android-chrome-192x192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "apple-touch-icon.png",
              type: "image/png",
              sizes: "180x180",
            },
            {
              src: "favicon-32x32.png",
              sizes: "32x32",
              type: "image/png",
            },
            {
              src: "favicon-16x16.png",
              sizes: "16x16",
              type: "image/png",
            },
          ],
          start_url: "/",
          id: "lawha",
          display: "standalone",
          theme_color: "#141310",
          background_color: "#f7f4ed",
          file_handlers: [
            {
              action: "/",
              accept: {
                "application/vnd.excalidraw+json": [".excalidraw"],
              },
            },
          ],
          share_target: {
            action: "/web-share-target",
            method: "POST",
            enctype: "multipart/form-data",
            params: {
              files: [
                {
                  name: "file",
                  accept: [
                    "application/vnd.excalidraw+json",
                    "application/json",
                    ".excalidraw",
                  ],
                },
              ],
            },
          },
          screenshots: [
            {
              src: "/screenshots/virtual-whiteboard.png",
              type: "image/png",
              sizes: "462x945",
            },
            {
              src: "/screenshots/wireframe.png",
              type: "image/png",
              sizes: "462x945",
            },
            {
              src: "/screenshots/illustration.png",
              type: "image/png",
              sizes: "462x945",
            },
            {
              src: "/screenshots/shapes.png",
              type: "image/png",
              sizes: "462x945",
            },
            {
              src: "/screenshots/collaboration.png",
              type: "image/png",
              sizes: "462x945",
            },
            {
              src: "/screenshots/export.png",
              type: "image/png",
              sizes: "462x945",
            },
          ],
        },
      }),
      createHtmlPlugin({
        minify: true,
      }),
    ],
    publicDir: "../public",
  };
});
