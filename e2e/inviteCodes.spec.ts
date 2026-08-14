import { expect, test } from "@playwright/test";

import type { Browser, Page } from "@playwright/test";

/**
 * Invite codes and grab-the-canvas panning, driven end to end against a real
 * stack. ADR 0014 and ADR 0013.
 *
 * Both are pinned by unit and integration tests already, and both have the
 * shape those cannot reach. An invite is only worth anything if the person
 * who redeems it still has the board tomorrow — that is a claim about a
 * `board_members` row surviving a fresh sign-in in a browser that has never
 * seen the board, which is three layers away from anything a mocked test
 * touches. Panning is a claim about the viewport actually moving under a real
 * pointer.
 *
 * **Asserted on the artefact, not on a proxy for it**, in the register the
 * rest of this suite uses: the board's presence is read from the dashboard
 * the redeemer sees, and the pan from where the ink actually moved to.
 *
 * The second of those was got wrong first time and is worth recording. The
 * original check compared the canvas before and after a right-drag and
 * expected the bytes to differ — on an **empty** board, which looks identical
 * however far you scroll it. It reported the feature broken while the feature
 * worked. `scrollX` was not available to read instead: `window.h` is gated on
 * dev/test builds and is simply undefined against the Docker stack, which is
 * the documented trap this suite has fallen into before.
 *
 * Not in the default run: it registers accounts and creates boards, and the
 * visual baselines assume the shared account has none. Run it against a built
 * stack — `LAWHA_E2E_BASE_URL=https://localhost yarn test:e2e:invites`.
 */

const PASSWORD = "correct-horse-battery";
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** A screenshot per step, so a failure is legible without a rerun. */
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/invite-codes/${name}.png` });

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

const signIn = async (page: Page, username: string) => {
  await page.goto("/signin");
  const result = await page.evaluate(
    async ([u, p]) => {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      return { ok: response.ok, status: response.status };
    },
    [username, PASSWORD] as const,
  );
  if (!result.ok) {
    throw new Error(`sign-in failed with ${result.status}`);
  }
};

const createBoard = async (page: Page, name: string): Promise<string> =>
  page.evaluate(async (boardName) => {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(10)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await fetch("/api/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: boardName }),
    });
    return id;
  }, name);

/**
 * A board with one rectangle in it.
 *
 * The rectangle is not decoration — it is the only way to see a pan. An empty
 * canvas looks byte-identical however far you scroll it, so the first version
 * of the panning test below compared two blank images and reported the
 * feature broken. That is precisely the "assert on a proxy" failure this
 * suite has a standing note about, committed by the note's own author.
 */
const createBoardWithShape = async (
  page: Page,
  name: string,
): Promise<string> => {
  const id = await createBoard(page, name);
  await page.evaluate(async (boardId) => {
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
    await fetch(`/api/boards/${boardId}/scene`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Lawha-Expected-Rev": "",
        "X-Lawha-Scene-Version": "4",
      },
      body: new TextEncoder().encode(JSON.stringify(elements)),
    });
  }, id);
  return id;
};

/**
 * Where the ink is, as a centre of mass in canvas pixels.
 *
 * Panning moves the drawing across the viewport, so the centroid moves with
 * it — a direct reading of the thing that is supposed to have happened,
 * rather than of a repaint that could have any cause. Sampled every 40th
 * pixel, matching `paintedPixels` in `openBoards.spec.ts`.
 */
const inkCentroid = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector(
      "canvas.static",
    ) as HTMLCanvasElement | null;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return null;
    }
    const { width, height } = canvas;
    const { data } = context.getImageData(0, 0, width, height);
    const bg = [data[0], data[1], data[2], data[3]];
    let sumX = 0;
    let sumY = 0;
    let painted = 0;
    for (let i = 0; i < data.length; i += 4 * 40) {
      if (
        Math.abs(data[i] - bg[0]) > 8 ||
        Math.abs(data[i + 1] - bg[1]) > 8 ||
        Math.abs(data[i + 2] - bg[2]) > 8 ||
        Math.abs(data[i + 3] - bg[3]) > 8
      ) {
        const pixel = i / 4;
        sumX += pixel % width;
        sumY += Math.floor(pixel / width);
        painted++;
      }
    }
    return painted === 0
      ? null
      : { x: sumX / painted, y: sumY / painted, painted };
  });

/** The ids on the dashboard the API answers with, which is what it renders. */
const myBoardIds = (page: Page) =>
  page.evaluate(async () => {
    const response = await fetch("/api/boards");
    const { boards } = (await response.json()) as {
      boards: Array<{ id: string }>;
    };
    return boards.map((board) => board.id);
  });

const freshContext = async (browser: Browser) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  return { context, page: await context.newPage() };
};

/**
 * Deletes the account the page is signed in as, boards and all.
 *
 * Every test here registers accounts on whatever server it is pointed at, and
 * the deployment this was written against had already accumulated forty-odd
 * `pw-*` and `qa-*` leftovers from earlier suites — enough that the
 * administration panel needed a search box to be usable. A spec that adds to
 * that pile on every run is the reason it exists.
 *
 * Non-fatal: a run killed midway leaves an account behind, and failing the
 * teardown would turn that into a red suite for a disposable row.
 */
const deleteAccount = async (page: Page) => {
  try {
    await page.evaluate(async (password) => {
      await fetch("/api/auth/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
    }, PASSWORD);
  } catch {
    // The context may already be closing. Not worth a failure.
  }
};

test.describe("an invite code gets somebody onto a board, for good", () => {
  test("the owner mints a code and the panel reads it out", async ({
    browser,
  }) => {
    const owner = await freshContext(browser);
    const name = `pw-inv-own-${stamp()}`;
    await register(owner.page, name);
    const boardId = await createBoard(owner.page, "Sprint plan");

    await owner.page.goto(`/b/${boardId}`);
    await owner.page.getByRole("button", { name: "Share this board" }).click();

    // The section exists and says what a code actually does, which is the
    // sentence the whole feature turns on: it is not another link.
    await expect(owner.page.getByText("Invite with a code")).toBeVisible();
    await expect(
      owner.page.getByText(/stays on their dashboard/),
    ).toBeVisible();

    await owner.page.getByRole("button", { name: "Make a code" }).click();

    // Three words, spaced so they can be dictated. Read from the DOM rather
    // than from the response, because being legible on screen is the point.
    const code = owner.page.locator(".lw-codes__code").first();
    await expect(code).toBeVisible({ timeout: 15_000 });
    expect((await code.textContent())?.trim()).toMatch(
      /^[a-z]+ · [a-z]+ · [a-z]+$/,
    );

    await shot(owner.page, "01-share-panel-with-code");
    await deleteAccount(owner.page);
    await owner.context.close();
  });

  test("a stranger redeems it and still has the board on a fresh sign-in", async ({
    browser,
  }) => {
    const owner = await freshContext(browser);
    const ownerName = `pw-inv-own-${stamp()}`;
    await register(owner.page, ownerName);
    const boardId = await createBoard(owner.page, "Sprint plan");

    const { code } = await owner.page.evaluate(async (id) => {
      const response = await fetch(`/api/boards/${id}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "editor" }),
      });
      return (await response.json()) as { code: string };
    }, boardId);
    expect(code.split("-")).toHaveLength(3);

    // A second person, in a browser that has never seen this board.
    const mate = await freshContext(browser);
    const mateName = `pw-inv-join-${stamp()}`;
    await register(mate.page, mateName);
    expect(await myBoardIds(mate.page)).not.toContain(boardId);

    await mate.page.goto(`/join/${code}`);

    // It previews before it redeems. The board's name and what the code
    // grants are both on screen, and nothing has happened yet — landing on a
    // link must not silently add you to a stranger's board.
    await expect(mate.page.getByText("Sprint plan")).toBeVisible({
      timeout: 15_000,
    });
    await expect(mate.page.getByText(/draw on it/)).toBeVisible();
    expect(await myBoardIds(mate.page)).not.toContain(boardId);
    await shot(mate.page, "02-join-preview");

    await mate.page.getByRole("button", { name: "Join this board" }).click();
    await mate.page.waitForURL(`**/b/${boardId}`, { timeout: 20_000 });
    await shot(mate.page, "03-joined-board");

    // The assertion the whole feature exists for. Not "the board opened" —
    // a link could do that — but that it is still theirs on a session that
    // knows nothing about how they got here.
    await mate.context.close();
    const later = await freshContext(browser);
    await signIn(later.page, mateName);
    expect(await myBoardIds(later.page)).toContain(boardId);
    await later.page.goto("/home");
    await shot(later.page, "04-still-on-the-dashboard");

    // And the owner is told who came in.
    await owner.page.reload();
    const redeemers = await owner.page.evaluate(async (id) => {
      const response = await fetch(`/api/boards/${id}/invites`);
      const { invites } = (await response.json()) as {
        invites: Array<{ redeemedBy: Array<{ username: string }> }>;
      };
      return invites.flatMap((invite) =>
        invite.redeemedBy.map((r) => r.username),
      );
    }, boardId);
    expect(redeemers).toContain(mateName);

    await deleteAccount(later.page);
    await later.context.close();
    await deleteAccount(owner.page);
    await owner.context.close();
  });

  test("a revoked code stops working and says why", async ({ browser }) => {
    const owner = await freshContext(browser);
    await register(owner.page, `pw-inv-own-${stamp()}`);
    const boardId = await createBoard(owner.page, "Sprint plan");

    const { code } = await owner.page.evaluate(async (id) => {
      const response = await fetch(`/api/boards/${id}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "editor" }),
      });
      return (await response.json()) as { code: string };
    }, boardId);

    await owner.page.evaluate(
      async ([id, c]) => {
        await fetch(`/api/boards/${id}/invites/${c}`, { method: "DELETE" });
      },
      [boardId, code] as const,
    );

    const mate = await freshContext(browser);
    await register(mate.page, `pw-inv-join-${stamp()}`);
    await mate.page.goto(`/join/${code}`);

    await expect(mate.page.getByRole("alert")).toContainText(/turned off/i, {
      timeout: 15_000,
    });
    await expect(
      mate.page.getByRole("button", { name: "Join this board" }),
    ).toHaveCount(0);
    expect(await myBoardIds(mate.page)).not.toContain(boardId);
    await shot(mate.page, "05-revoked-code");

    await deleteAccount(mate.page);
    await mate.context.close();
    await deleteAccount(owner.page);
    await owner.context.close();
  });
});

test.describe("holding the canvas", () => {
  test("a right-button drag moves the viewport and leaves no menu", async ({
    browser,
  }) => {
    const owner = await freshContext(browser);
    await register(owner.page, `pw-pan-${stamp()}`);
    const boardId = await createBoardWithShape(owner.page, "Panning");

    await owner.page.goto(`/b/${boardId}`);
    const canvas = owner.page.locator("canvas.interactive");
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Wait for the rectangle to actually be on the canvas. Measuring before it
    // has painted would compare two empty images and call that a pass.
    await expect
      .poll(async () => (await inkCentroid(owner.page))?.painted ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThan(20);

    const before = (await inkCentroid(owner.page))!;
    const box = (await canvas.boundingBox())!;
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    await owner.page.mouse.move(from.x, from.y);
    await owner.page.mouse.down({ button: "right" });
    for (let step = 1; step <= 8; step++) {
      await owner.page.mouse.move(from.x + step * 20, from.y - step * 10);
      await owner.page.waitForTimeout(16);
    }
    await owner.page.mouse.up({ button: "right" });
    await owner.page.waitForTimeout(800);

    // The drawing moved with the pointer: right and up, because `scrollX`
    // grows with `clientX`. A sign error here is the bug where the canvas
    // flies the opposite way from the hand, and it would pass a mere
    // "something repainted" check.
    const after = (await inkCentroid(owner.page))!;
    expect(after.x).toBeGreaterThan(before.x + 40);
    expect(after.y).toBeLessThan(before.y - 20);

    // And the right button did not leave a context menu behind.
    await expect(owner.page.locator(".context-menu")).toHaveCount(0);
    await shot(owner.page, "06-after-right-drag");

    // A right *click* still gets its menu — the half that would otherwise be
    // silently lost, since suppressing the native one is how the drag works.
    await owner.page.mouse.click(from.x, from.y, { button: "right" });
    await expect(owner.page.locator(".context-menu")).toBeVisible({
      timeout: 5_000,
    });
    await shot(owner.page, "07-right-click-menu");

    await deleteAccount(owner.page);
    await owner.context.close();
  });
});
