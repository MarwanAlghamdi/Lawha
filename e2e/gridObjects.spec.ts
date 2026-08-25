import { expect, test } from "./fixtures";

import type { Page } from "@playwright/test";

/**
 * Grid objects survive the round trip, with their per-cell properties.
 *
 * `e2e/gridObjects.spec.ts` was deleted with the composed design (ADR 0026)
 * and never rewritten, which known issue 20's neighbours record as a gap. This
 * is its replacement, and it is deliberately not the old one: the composed
 * objects needed a spec to prove they held together at all, and a native
 * element type does not.
 *
 * What needs proving now is the thing no unit test can reach. ADR 0027 added
 * four per-cell properties, and `restoreElement`'s `table` case does not spread
 * a cell — it rebuilds it field by field, so a key it does not name is dropped
 * on EVERY ingest path, including remote elements during collaboration. A unit
 * test can assert `restore` keeps them. Only a real server can prove the whole
 * path does: draw it, let it save, leave, come back, and look.
 *
 * The failure this guards against is specific and quiet — alignment that works,
 * survives a reload of your own tab, and disappears the moment a second
 * person's client round-trips the scene.
 */

/** Drags out a table with the table tool. */
const drawTable = async (page: Page) => {
  await page.evaluate(() => {
    (window as any).h.app.setActiveTool({ type: "table" });
  });
  await page.waitForTimeout(300);

  // The gaps are load-bearing for the same reason `persistence.spec.ts` says:
  // the pointer-move handler is throttled to an animation frame, so a drag
  // fired in one tick collapses to a zero-size shape.
  await page.mouse.move(320, 260);
  await page.mouse.down();
  for (const [x, y] of [
    [420, 300],
    [560, 350],
    [700, 400],
    [800, 440],
  ]) {
    await page.waitForTimeout(80);
    await page.mouse.move(x, y);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
};

/** The live table element according to the editor itself. */
const readTable = (page: Page) =>
  page.evaluate(() => {
    const el = (window as any).h?.elements.find(
      (e: any) => e.type === "table" && !e.isDeleted,
    );
    if (!el) {
      return null;
    }
    return {
      id: el.id,
      textAlign: el.textAlign,
      verticalAlign: el.verticalAlign,
      cells: el.cells,
      colWidths: el.colWidths,
      rowHeights: el.rowHeights,
    };
  });

/**
 * Writes per-cell properties through the editor's own scene, rather than by
 * driving the panel.
 *
 * The panel is covered by unit tests. What is under test here is persistence,
 * and going through the interior-handle selection UI to reach it would make a
 * failure ambiguous between "the property did not save" and "the click missed
 * a divider".
 */
const setCellProperties = (page: Page) =>
  page.evaluate(() => {
    const h = (window as any).h;
    const elements = h.elements.map((el: any) => {
      if (el.type !== "table" || el.isDeleted) {
        return el;
      }
      const cells = el.cells.map((row: any[], r: number) =>
        row.map((cell: any, c: number) => {
          if (r === 0 && c === 0) {
            return { ...cell, text: "Model", align: "left", bold: false };
          }
          if (r === 0 && c === 1) {
            return { ...cell, text: "Acc", align: "right" };
          }
          if (r === 1 && c === 0) {
            return {
              ...cell,
              text: "Ours",
              verticalAlign: "bottom",
              italic: true,
            };
          }
          if (r === 1 && c === 1) {
            return { ...cell, text: "94.1", align: "center", bold: true };
          }
          return cell;
        }),
      );
      return { ...el, cells, verticalAlign: "middle", version: el.version + 1 };
    });
    h.elements = elements;
  });

test.describe("grid objects survive a round trip", () => {
  const created: string[] = [];

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

  test("a table is one element, and its per-cell properties persist", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/");
    await page.locator(".lw-home__new-tile").click();
    await page.locator("canvas").first().waitFor();
    await page.waitForTimeout(2500);

    const boardPath = new URL(page.url()).pathname;
    expect(boardPath).toMatch(/^\/b\//);
    created.push(boardPath.replace("/b/", ""));

    await drawTable(page);

    // ADR 0026's whole claim: one element, not a pile of rectangles and text.
    const liveCount = await page.evaluate(
      () =>
        (window as any).h.elements.filter((el: any) => !el.isDeleted).length,
    );
    expect(liveCount).toBe(1);

    const drawn = await readTable(page);
    expect(drawn).not.toBeNull();
    // The invariant the geometry rests on — fractions summing to 1.
    expect(
      drawn!.colWidths.reduce((a: number, b: number) => a + b, 0),
    ).toBeCloseTo(1);

    await setCellProperties(page);

    const before = await readTable(page);
    expect(before!.cells[0][0].align).toBe("left");
    expect(before!.cells[1][1].bold).toBe(true);

    // Past the save interval. Local saving is paused while collaborating, so
    // the server copy is the only one there is (invariant 17).
    await page.waitForTimeout(7000);

    await page.getByLabel("Back to all boards").click();
    await page.locator(".lw-home__new-tile").waitFor();

    await page.locator(`[aria-label^="Open "]`).first().click();
    await page.locator("canvas").first().waitFor();

    await expect
      .poll(async () => (await readTable(page))?.cells?.[0]?.[0]?.text, {
        timeout: 20_000,
      })
      .toBe("Model");

    const after = await readTable(page);

    // The element-level default.
    expect(after!.verticalAlign).toBe("middle");

    // Every per-cell property, individually, because `restore.ts` names them
    // one at a time and missing one is exactly how this breaks.
    expect(after!.cells[0][0].align).toBe("left");
    expect(after!.cells[0][0].bold).toBe(false); // false is a real answer
    expect(after!.cells[0][1].align).toBe("right");
    expect(after!.cells[1][0].verticalAlign).toBe("bottom");
    expect(after!.cells[1][0].italic).toBe(true);
    expect(after!.cells[1][1].align).toBe("center");
    expect(after!.cells[1][1].bold).toBe(true);

    // And the fill/colour keys that predate 0027 are still null, not lost.
    expect(after!.cells[0][0].fill).toBeNull();
    expect(after!.cells[0][0].color).toBeNull();
  });
});
