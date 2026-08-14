import { expect, test } from "./fixtures";

import type { Page } from "@playwright/test";

/**
 * The guarantee the whole product rests on: work drawn on a board survives
 * leaving it.
 *
 * This existed only as an ad-hoc script in a temp directory, which was wiped
 * mid-session and took the check with it — so it lives in the repo now. It is
 * behavioural, not visual: no screenshots, and it runs once rather than across
 * the viewport x theme matrix, because nothing here depends on either.
 *
 * It covers the two bugs that made a board lose its contents:
 *
 *  - Opening a board from the dashboard used to reach a `/b/<id>` with no key
 *    in the URL, which the link parser treated as an error.
 *  - Leaving a board used to flush an *empty* scene over it, because the
 *    teardown read the scene back out of an editor that had already unmounted.
 *
 * Neither was visible on screen. The only honest way to check is to draw
 * something, leave, come back, and look for it.
 */

/**
 * Drags out a rectangle on the canvas.
 *
 * The gaps between moves are load-bearing: the editor's pointer-move handler is
 * throttled to an animation frame, so a drag fired in one tick collapses to a
 * zero-size shape — which the sync layer then correctly discards as invisible,
 * looking exactly like a broken save.
 */
const drawRectangle = async (page: Page) => {
  await page.evaluate(() => {
    (window as any).h.app.setActiveTool({ type: "rectangle" });
  });
  await page.waitForTimeout(300);

  await page.mouse.move(400, 300);
  await page.mouse.down();
  for (const [x, y] of [
    [460, 350],
    [540, 420],
    [620, 480],
    [700, 540],
  ]) {
    await page.waitForTimeout(80);
    await page.mouse.move(x, y);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
};

/** Live elements according to the editor itself, via its dev handle. */
const elementCount = (page: Page) =>
  page.evaluate(
    () =>
      (window as any).h?.elements.filter((el: any) => !el.isDeleted).length ??
      -1,
  );

test.describe("a board keeps what you draw on it", () => {
  const created: string[] = [];

  // These specs create boards, and the dashboard's visual baseline assumes the
  // shared account has none. Leaving them behind would turn every later visual
  // run red for a reason that has nothing to do with the code.
  test.afterAll(async ({ browser }) => {
    if (!created.length) {
      return;
    }
    const page = await browser.newPage();
    await page.goto("/");
    for (const id of created) {
      await page.evaluate(
        (boardId) =>
          fetch(`/api/boards/${boardId}`, { method: "DELETE" }).then(() => {}),
        id,
      );
    }
    await page.close();
  });

  test("survives leaving the board and coming back", async ({ page }) => {
    test.slow();

    await page.goto("/");
    await page.locator(".lw-home__new-tile").click();
    await page.locator("canvas").first().waitFor();
    await page.waitForTimeout(2500);

    const boardPath = new URL(page.url()).pathname;
    expect(boardPath).toMatch(/^\/b\//);
    created.push(boardPath.replace("/b/", ""));

    // The key stays out of the URL — it is already on this device. That this
    // is *not* an error is the whole first half of the fix.
    expect(new URL(page.url()).hash).toBe("");

    await drawRectangle(page);
    expect(await elementCount(page)).toBe(1);

    // Past the save interval, so the scene has reached the server. Nothing is
    // written to local storage while collaborating, so the server copy is the
    // only one there is.
    await page.waitForTimeout(7000);

    await page.getByLabel("Back to all boards").click();
    await page.locator(".lw-home__new-tile").waitFor();

    await page.locator(`[aria-label^="Open "]`).first().click();
    await page.locator("canvas").first().waitFor();

    // Reloaded from the server, so give it a moment to arrive rather than
    // asserting on the first frame.
    await expect.poll(() => elementCount(page), { timeout: 20_000 }).toBe(1);
  });

  test("a board opened from the dashboard joins its room", async ({ page }) => {
    // If it did not, the same board would be a live document by share link and
    // a local-only copy by dashboard, and work on the local copy would be
    // stranded where nobody else could ever see it.
    await page.goto("/");
    await page.locator(".lw-home__new-tile").click();
    await page.locator("canvas").first().waitFor();

    const boardId = new URL(page.url()).pathname.replace("/b/", "");
    created.push(boardId);

    await expect
      .poll(
        async () =>
          page.evaluate(async (id) => {
            const list = await fetch("/api/boards").then((r) => r.json());
            return (list.editing ?? {})[id] ?? 0;
          }, boardId),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
  });
});
