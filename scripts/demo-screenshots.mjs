/**
 * Regenerates the README screenshots under `docs/screenshots/`.
 *
 * **Point this at a throwaway stack, never at a real one.** It registers four
 * accounts, creates five boards, three folders and three tags, and adds a
 * member to a board — none of which it cleans up. `docs/lawha-roadmap.md`
 * known issue 30 records what that costs when it is aimed at a deployment
 * people use: six runs took one server from 48 accounts to 70, and every one
 * of them had to be removed by hand afterwards. So there is no default base
 * URL and no default password; both must be passed, and the URL must not be
 * the port a real Lawha is on.
 *
 * Stand a scratch stack up beside your real one — that is what `LAWHA_STACK`
 * exists for, and it needs its own data directory or the two share a SQLite
 * file:
 *
 *   SCRATCH=/tmp/lawha-shots
 *   mkdir -p $SCRATCH/data $SCRATCH/backups && chmod 700 $SCRATCH/backups
 *   LAWHA_STACK=lawhashots LAWHA_DATA_DIR=$SCRATCH/data \
 *   LAWHA_BACKUP_DIR=$SCRATCH/backups LAWHA_PUBLISHED_PORT=9052 \
 *     docker compose -p lawhashots up -d --build
 *
 *   LAWHA_SHOTS_URL=http://localhost:9052 \
 *   LAWHA_SHOTS_PASSWORD=demo-password-1 \
 *     node scripts/demo-screenshots.mjs
 *
 *   docker compose -p lawhashots down -v && rm -rf $SCRATCH
 *
 * A fresh stack mints a first-boot administrator from `LAWHA_ADMIN_USERNAME`
 * in whatever `lawha.env` it loaded — which on your own machine is your own
 * username, and it would appear in the admin screenshot. This deletes that
 * account and promotes `yasmin` instead, which is why the shots show a persona
 * rather than an operator.
 *
 * Why this is committed rather than run by hand once: the screenshots go stale
 * exactly the way the visual baselines did (known issue 18 — sixteen of them
 * drifted for batch after batch while the suite could not even run). A picture
 * of a UI that no longer exists is a claim, and claims rot.
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const BASE = process.env.LAWHA_SHOTS_URL;
const PASSWORD = process.env.LAWHA_SHOTS_PASSWORD;
const STACK = process.env.LAWHA_SHOTS_STACK ?? "lawhashots";
const OUT = process.env.LAWHA_SHOTS_OUT ?? "docs/screenshots";

if (!BASE || !PASSWORD) {
  console.error(
    "lawha: set LAWHA_SHOTS_URL and LAWHA_SHOTS_PASSWORD.\n" +
      "Both are deliberately required — see this file's header for why, and\n" +
      "for the scratch stack to point them at.",
  );
  process.exit(2);
}

/** The default published port. Refusing it is the guard, not a suggestion. */
if (/:9002(\/|$)/.test(BASE)) {
  console.error(
    `lawha: ${BASE} is the default published port, which is where a real\n` +
      "deployment lives. This script leaves accounts and boards behind. Point\n" +
      "it at a scratch stack on another port.",
  );
  process.exit(2);
}

const PEOPLE = ["yasmin", "omar", "layla", "sami"];
const ADMIN = PEOPLE[0];

const el = (over) => ({
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: { type: 3 },
  seed: 1,
  version: 10,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...over,
});

let n = 0;
const box = (x, y, w, h, fill) =>
  el({
    id: `r${++n}`,
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    backgroundColor: fill ?? "transparent",
    index: `a${n}`,
  });
const ellipse = (x, y, w, h, fill) =>
  el({
    id: `e${++n}`,
    type: "ellipse",
    x,
    y,
    width: w,
    height: h,
    backgroundColor: fill ?? "transparent",
    index: `a${n}`,
  });
const text = (x, y, t, size = 20) =>
  el({
    id: `t${++n}`,
    type: "text",
    x,
    y,
    width: t.length * size * 0.55,
    height: size * 1.25,
    text: t,
    originalText: t,
    fontSize: size,
    fontFamily: 5,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    lineHeight: 1.25,
    autoResize: true,
    roundness: null,
    index: `a${n}`,
  });
const arrow = (x, y, dx, dy) =>
  el({
    id: `a${++n}`,
    type: "arrow",
    x,
    y,
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      [0, 0],
      [dx, dy],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
    roundness: { type: 2 },
    index: `a${n}`,
  });

const architecture = () => {
  n = 0;
  return [
    text(120, 90, "Lawha — how a board reaches a browser", 28),
    box(120, 160, 220, 90, "#d0f0e0"),
    text(150, 192, "browser"),
    arrow(350, 205, 110, 0),
    box(470, 160, 220, 90, "#e8e0ff"),
    text(500, 180, "nginx"),
    text(500, 208, "serves + proxies", 14),
    arrow(700, 205, 110, 0),
    box(820, 160, 240, 90, "#ffe8cc"),
    text(850, 180, "lawha-server"),
    text(850, 208, "REST + socket relay", 14),
    arrow(940, 260, 0, 90),
    ellipse(830, 360, 220, 110, "#ffd9d9"),
    text(880, 400, "SQLite"),
    box(470, 360, 220, 110, "#e0eeff"),
    text(500, 385, "lawha-backup", 18),
    text(500, 412, "verified snapshots", 13),
    text(500, 434, "on a timer", 13),
    arrow(820, 415, -120, 0),
    text(120, 540, "One port published. No hosted services.", 18),
  ];
};

const retro = () => {
  n = 0;
  return [
    text(140, 110, "Sprint 14 — retro", 26),
    box(140, 170, 260, 300, "#d3f9d8"),
    text(170, 195, "Went well"),
    text(170, 240, "backup rehearsal", 15),
    text(170, 270, "share links landed", 15),
    text(170, 300, "admin audit log", 15),
    box(440, 170, 260, 300, "#ffe3e3"),
    text(470, 195, "Hurt"),
    text(470, 240, "flaky avatar test", 15),
    text(470, 270, "stale baselines", 15),
    box(740, 170, 260, 300, "#e7f5ff"),
    text(770, 195, "Try next"),
    text(770, 240, "tighten the mask", 15),
    text(770, 270, "pull upstream", 15),
  ];
};

const onboarding = () => {
  n = 0;
  return [
    text(150, 120, "Onboarding a new teammate", 26),
    ellipse(150, 190, 190, 90, "#d0ebff"),
    text(190, 225, "invite code", 18),
    arrow(345, 235, 100, 0),
    box(455, 190, 200, 90, "#fff3bf"),
    text(485, 225, "they sign up", 18),
    arrow(660, 235, 100, 0),
    box(770, 190, 210, 90, "#d3f9d8"),
    text(800, 215, "viewer or editor", 16),
    text(800, 243, "on that board", 14),
    text(150, 340, "No email anywhere. The code is the whole handover.", 17),
  ];
};

const post = (page, url, body) =>
  page.evaluate(
    async ([u, b]) => {
      const r = await fetch(u, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
      return { ok: r.ok, status: r.status };
    },
    [url, body],
  );

const patch = (page, url, body) =>
  page.evaluate(
    async ([u, b]) => {
      const r = await fetch(u, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
      return r.status;
    },
    [url, body],
  );

const get = (page, url) =>
  page.evaluate(async (u) => (await fetch(u)).json(), url);

const signIn = async (ctx, user) => {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/signin`);
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), {
    timeout: 20000,
  });
  return page;
};

/**
 * Registration and the admin swap both happen before any browser opens.
 *
 * The swap is SQL rather than the API on purpose: the server refuses to remove
 * its last administrator, and it is right to. This is a disposable database.
 */
const seedAccounts = async () => {
  for (const u of PEOPLE) {
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: PASSWORD }),
    });
    if (!r.ok && r.status !== 409) {
      throw new Error(`register ${u} failed with ${r.status}`);
    }
  }
  const js = `
    const D = require("better-sqlite3");
    const db = new D("/data/lawha.db");
    db.prepare("UPDATE users SET is_admin=1 WHERE username_lower=?").run(${JSON.stringify(ADMIN)});
    db.prepare("DELETE FROM users WHERE is_admin=1 AND username_lower<>?").run(${JSON.stringify(ADMIN)});
    db.close();
  `;
  execFileSync("docker", ["exec", `${STACK}-server`, "node", "-e", js], {
    stdio: "inherit",
  });
};

const main = async () => {
  await seedAccounts();
  console.log(`seeded ${PEOPLE.length} accounts; ${ADMIN} is the administrator`);

  const browser = await chromium.launch();
  const viewport = { width: 1440, height: 900 };
  const ctxA = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await signIn(ctxA, ADMIN);

  for (const name of ["Product", "Engineering", "Archive"]) {
    await post(page, "/api/folders", { name });
  }
  for (const name of ["design", "infra", "planning"]) {
    await post(page, "/api/tags", { name });
  }

  const boards = [
    ["Architecture", architecture()],
    ["Sprint 14 retro", retro()],
    ["Onboarding flow", onboarding()],
    ["Q3 roadmap", retro()],
    ["Network diagram", architecture()],
  ];
  for (const [name, elements] of boards) {
    const id = Array.from(
      { length: 20 },
      () => "0123456789abcdef"[Math.floor(n++ % 16)],
    ).join("");
    await post(page, "/api/boards", { id, name });
    await page.evaluate(
      async ([b, els]) => {
        await fetch(`/api/boards/${b}/scene`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Lawha-Expected-Rev": "",
            "X-Lawha-Scene-Version": "40",
          },
          body: new TextEncoder().encode(JSON.stringify(els)),
        });
      },
      [id, elements],
    );
  }

  // Tag and file them, using the ids the server actually minted. The POST
  // responses are not shaped `{ id }`, which is how the first run of this
  // silently produced a dashboard where every board read "untagged".
  const { tags } = await get(page, "/api/tags");
  const { folders } = await get(page, "/api/folders");
  const { boards: made } = await get(page, "/api/boards");
  const tag = (nm) => tags.find((t) => t.name === nm)?.id;
  const folder = (nm) => folders.find((f) => f.name === nm)?.id;
  const board = (nm) => made.find((b) => b.name === nm)?.id;

  for (const [i, nm] of ["design", "infra", "planning"].entries()) {
    await patch(page, `/api/tags/${tag(nm)}`, { colorIndex: i * 2 });
  }
  const filing = [
    ["Architecture", ["infra"], "Engineering"],
    ["Network diagram", ["infra"], "Engineering"],
    ["Sprint 14 retro", ["planning"], "Product"],
    ["Onboarding flow", ["design"], "Product"],
    ["Q3 roadmap", ["planning", "design"], null],
  ];
  for (const [nm, tagNames, folderName] of filing) {
    const body = { tagIds: tagNames.map(tag) };
    if (folderName) body.folderId = folder(folderName);
    await patch(page, `/api/boards/${board(nm)}`, body);
  }

  const shot = async (p, name) => {
    await p.evaluate(() => document.activeElement?.blur());
    await p.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log("  ", name);
  };

  await page.goto(`${BASE}/`);
  await page.waitForTimeout(3000);
  await shot(page, "dashboard");

  const boardId = board("Architecture");

  const { users } = await get(page, "/api/admin/users");
  const omar = users.find(
    (u) => (u.username ?? u.usernameDisplay ?? "").toLowerCase() === "omar",
  );
  if (omar) {
    await page.evaluate(
      async ([b, u]) => {
        await fetch(`/api/boards/${b}/members/${u}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "editor" }),
        });
      },
      [boardId, omar.id],
    );
  }

  await page.goto(`${BASE}/b/${boardId}`);
  await page.waitForSelector("canvas", { timeout: 20000 });
  await page.waitForTimeout(4000);
  await shot(page, "board");

  const share = page.getByRole("button", { name: "Share this board" });
  if (await share.count()) {
    await share.first().click();
    await page.waitForTimeout(1500);
    await shot(page, "share");
  }

  // Two people on one board. A remote cursor is only drawn once its owner has
  // moved, so the second context moves and then holds still.
  const ctxB = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const second = await signIn(ctxB, "omar");
  await second.goto(`${BASE}/b/${boardId}`);
  await second.waitForSelector("canvas", { timeout: 20000 });
  await second.waitForTimeout(4000);
  for (const [x, y] of [
    [700, 500],
    [820, 560],
    [900, 610],
    [960, 640],
  ]) {
    await second.mouse.move(x, y, { steps: 8 });
    await second.waitForTimeout(250);
  }

  await page.reload();
  await page.waitForSelector("canvas", { timeout: 20000 });
  await page.waitForTimeout(3500);
  await second.mouse.move(965, 645, { steps: 2 });
  await page.waitForTimeout(2500);
  await shot(page, "collaboration");

  await page.evaluate(() =>
    window.localStorage.setItem("excalidraw-theme", "dark"),
  );
  await page.reload();
  await page.waitForSelector("canvas", { timeout: 20000 });
  await page.waitForTimeout(3500);
  await shot(page, "board-dark");

  await page.evaluate(() =>
    window.localStorage.setItem("excalidraw-theme", "light"),
  );
  await page.goto(`${BASE}/admin`);
  await page.waitForTimeout(3000);
  await shot(page, "admin");

  await browser.close();
  console.log(`done — ${OUT}`);
};

main().catch((e) => {
  console.error("lawha: screenshot run failed:", e.message);
  process.exit(1);
});
