import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

/**
 * The change ADR 0012 made, driven end to end against a real stack.
 *
 * Every assertion here corresponds to something a person reported: their own
 * boards asking for a password, a padlock on everything shared with them, a
 * colour they could not change, a picture they could not remove, and a
 * photograph on their cursor they never opted into.
 *
 * **Asserted on the artefact, not on a proxy for it.** This repo has been
 * burned by a "drew a rectangle" check that counted `<canvas>` elements and
 * passed on an empty board — so the board tests read back element geometry and
 * the stored byte length, not the presence of a canvas.
 *
 * Not in the default run: it registers accounts and creates boards, and the
 * visual baselines depend on the shared account having none. Run it against a
 * built stack — `LAWHA_E2E_BASE_URL=https://localhost yarn test:e2e:open`.
 */

const PASSWORD = "correct-horse-battery";
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/**
 * Whether the canvas actually has something painted on it.
 *
 * **Not `window.h`.** Both `window.h` and `window.collab` are gated on
 * `isTestEnv() || isDevEnv()`, so against a production build — which is what
 * the Docker stack serves, and the only place this spec is worth running —
 * they are simply undefined and every probe through them reads empty rather
 * than failing loudly. The first draft of this file walked straight into this
 * trap: two tests reported the feature broken because the scene they were
 * reading did not exist to be read.
 *
 * Pixels instead. A "drew a rectangle" check that counted `<canvas>` elements
 * passes on an empty board, so this counts pixels that differ from the
 * canvas's own corner — the background — and requires enough of them to be a
 * shape rather than an antialiasing artefact.
 */
const paintedPixels = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector(
      "canvas.static",
    ) as HTMLCanvasElement | null;
    if (!canvas) {
      return 0;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return 0;
    }
    const { width, height } = canvas;
    const { data } = context.getImageData(0, 0, width, height);
    const bg = [data[0], data[1], data[2], data[3]];
    let painted = 0;
    // Every 40th pixel: a 260x180 rectangle's stroke is thousands of pixels,
    // and sampling keeps this off the critical path of a 30s budget.
    for (let i = 0; i < data.length; i += 4 * 40) {
      if (
        Math.abs(data[i] - bg[0]) > 8 ||
        Math.abs(data[i + 1] - bg[1]) > 8 ||
        Math.abs(data[i + 2] - bg[2]) > 8 ||
        Math.abs(data[i + 3] - bg[3]) > 8
      ) {
        painted++;
      }
    }
    return painted;
  });

/** A screenshot per step, so a failure is legible without a rerun. */
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/open-boards/${name}.png` });

const register = async (page: Page, username: string) => {
  await page.goto("/signin");
  const result = await page.evaluate(
    async ([u, p]) => {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      return { ok: response.ok, status: response.status };
    },
    [username, PASSWORD] as const,
  );
  if (!result.ok) {
    throw new Error(`registration failed with ${result.status}`);
  }
};

/** Creates a board through the API and draws one rectangle into it. */
const createBoard = async (page: Page, name: string) => {
  const boardId = await page.evaluate(async (boardName) => {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(10)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await fetch("/api/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: boardName }),
    });
    const elements = [
      {
        id: "rect-1",
        type: "rectangle",
        x: 120,
        y: 140,
        width: 260,
        height: 180,
        version: 4,
        versionNonce: 11,
        isDeleted: false,
        index: "a1",
        seed: 7,
        updated: 1,
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
        roundness: null,
        boundElements: null,
        link: null,
        locked: false,
      },
    ];
    // No `X-Lawha-Iv`: its absence is what marks the body as plaintext.
    await fetch(`/api/boards/${id}/scene`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Lawha-Expected-Rev": "",
        "X-Lawha-Scene-Version": "4",
      },
      body: new TextEncoder().encode(JSON.stringify(elements)),
    });
    return id;
  }, name);
  return boardId;
};

test.describe("a board opens because you may open it", () => {
  test("the dashboard shows no padlock and no unlock prompt", async ({
    page,
  }) => {
    const username = `qa-open-${stamp()}`;
    await register(page, username);
    const boardId = await createBoard(page, "Opens everywhere");

    await page.goto("/");
    await expect(page.getByText("Opens everywhere")).toBeVisible();
    await shot(page, "01-dashboard");

    // The three strings the report named, and the classes behind them.
    await expect(page.getByText(/locked in this browser/i)).toHaveCount(0);
    await expect(page.getByText(/Unlock my boards/i)).toHaveCount(0);
    await expect(page.locator(".lw-board-card--locked")).toHaveCount(0);
    await expect(page.locator(".lw-board-card__locked-note")).toHaveCount(0);

    expect(boardId).toHaveLength(20);
  });

  test("a board opens on a browser that has never held its key", async ({
    browser,
  }) => {
    // The headline case. Two contexts means two IndexedDB stores, which is
    // exactly the condition that used to produce "This board is locked here"
    // on somebody's own board — the key was minted in the first browser and
    // the second had no way to reach it without a password.
    const username = `qa-second-${stamp()}`;

    const first = await browser.newContext();
    const firstPage = await first.newPage();
    await register(firstPage, username);
    const boardId = await createBoard(firstPage, "Made elsewhere");
    await first.close();

    const second = await browser.newContext();
    const page = await second.newPage();
    await page.goto("/signin");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/signin"));

    await page.goto(`/b/${boardId}`);

    // Two independent artefacts, because each covers what the other cannot.
    //
    // The scene read proves authorization and the storage format: this second
    // browser, which has never held a key, gets the elements back. The painted
    // pixels prove the editor actually rendered them — a 200 from the API with
    // a blank canvas would be the same bug wearing a different number.
    const fetched = await page.evaluate(async (id) => {
      const response = await fetch(`/api/boards/${id}/scene`);
      return { status: response.status, body: await response.text() };
    }, boardId);
    expect(fetched.status).toBe(200);
    expect(JSON.parse(fetched.body)[0].width).toBe(260);

    await expect
      .poll(() => paintedPixels(page), { timeout: 25_000 })
      .toBeGreaterThan(20);

    await shot(page, "02-board-on-second-browser");
    await expect(page.getByText(/This board is locked here/i)).toHaveCount(0);
    await second.close();
  });

  test("the share link carries no key, and a stranger can follow it", async ({
    browser,
  }) => {
    const username = `qa-share-${stamp()}`;
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    await register(ownerPage, username);
    const boardId = await createBoard(ownerPage, "Shared by link");

    await ownerPage.evaluate(
      async (id) =>
        fetch(`/api/boards/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ linkAccess: "view" }),
        }),
      boardId,
    );

    const link = await ownerPage.evaluate(
      (id) => `${window.location.origin}/b/${id}`,
      boardId,
    );
    // The fragment is what a link used to have to carry.
    expect(link).not.toContain("#key=");
    await owner.close();

    // No account, no session, no fragment — only the link.
    const stranger = await browser.newContext();
    const page = await stranger.newPage();
    await page.goto(link);

    // Same pair as above. The scene read is the one that distinguishes "the
    // link works" from "the page loaded and the server refused", which a blank
    // canvas alone cannot.
    const asGuest = await page.evaluate(async (id) => {
      const response = await fetch(`/api/boards/${id}/scene`);
      return { status: response.status, body: await response.text() };
    }, boardId);
    expect(asGuest.status).toBe(200);
    expect(JSON.parse(asGuest.body)[0].id).toBe("rect-1");

    await expect
      .poll(() => paintedPixels(page), { timeout: 25_000 })
      .toBeGreaterThan(20);

    await shot(page, "03-link-visitor");
    await stranger.close();
  });
});

test.describe("account settings", () => {
  test("the colour is a picker, the picture can be removed, the cursor is off", async ({
    page,
  }) => {
    const username = `qa-account-${stamp()}`;
    await register(page, username);
    await page.goto("/account");
    await expect(page.getByLabel("Username")).toBeVisible();
    await shot(page, "04-account");

    // Off by default (migration 012). This is the control 009 turned on for
    // everybody without asking.
    await expect(
      page.getByRole("checkbox", {
        name: /Show my profile picture as my cursor/,
      }),
    ).not.toBeChecked();

    // A real picker, twelve swatches, each named.
    const swatches = page.getByRole("radiogroup", { name: "Your colour" });
    await expect(swatches).toBeVisible();
    await expect(swatches.getByRole("radio")).toHaveCount(12);

    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();

    await swatches.getByRole("radio", { name: "indigo" }).click();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText("Saved")).toBeVisible();
    await shot(page, "05-colour-saved");

    // Persisted, not merely echoed: reloaded from the server.
    await page.reload();
    await expect(page.getByRole("radio", { name: "indigo" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // No picture yet, so no way to remove one.
    await expect(
      page.getByRole("button", { name: "Remove picture" }),
    ).toHaveCount(0);

    // Upload one, then take it away again.
    const uploaded = await page.evaluate(async () => {
      // A 1x1 PNG, the smallest thing the sniffer will accept.
      const bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        ),
        (c) => c.charCodeAt(0),
      );
      const response = await fetch("/api/users/me/avatar", {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: bytes,
      });
      return response.status;
    });
    expect(uploaded).toBe(204);

    await page.reload();
    await expect(page.locator(".lw-avatar__img")).toBeVisible();
    await shot(page, "06-picture-added");

    await page.getByRole("button", { name: "Remove picture" }).click();

    // The artefact: the account is back to its initials.
    await expect(page.locator(".lw-avatar__img")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove picture" }),
    ).toHaveCount(0);
    await shot(page, "07-picture-removed");
  });
});

test.describe("storage", () => {
  test("a scene written by the app is readable plaintext on the wire", async ({
    page,
  }) => {
    const username = `qa-plain-${stamp()}`;
    await register(page, username);
    const boardId = await createBoard(page, "Plaintext");

    const stored = await page.evaluate(async (id) => {
      const response = await fetch(`/api/boards/${id}/scene`);
      return {
        iv: response.headers.get("x-lawha-iv"),
        body: await response.text(),
      };
    }, boardId);

    // The marker, and the payload behind it. A test that only checked the
    // header would pass against a server storing ciphertext with an empty IV.
    expect(stored.iv).toBe("");
    const elements = JSON.parse(stored.body);
    expect(elements[0].id).toBe("rect-1");
    expect(elements[0].width).toBe(260);
  });
});
