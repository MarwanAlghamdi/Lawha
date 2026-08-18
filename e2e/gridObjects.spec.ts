import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

/**
 * Tables, matrices and tensor blocks, driven end to end (ADR 0023).
 *
 * Two reported defects are pinned here, because both are consequences of the
 * composed design and neither is visible to a unit test:
 *
 *  - **"they should be as one and not grouping multiple things"** — inserting a
 *    table selected its twelve cells individually instead of selecting the one
 *    group they belong to, so the editor showed twelve selection outlines and
 *    every subsequent action operated on a dozen things.
 *  - **"undo things mess up everything"** — `updateScene` defaults to
 *    `CaptureUpdateAction.EVENTUALLY`, so an insert was not its own undo step.
 *    One Ctrl+Z has to take the whole table away, and one Ctrl+Shift+Z has to
 *    bring it back.
 *
 * **Runs against a sandbox, never a real deployment.** It registers accounts
 * and creates boards. Point `LAWHA_E2E_BASE_URL` at a stack with its own
 * database — see the sandbox notes in the PR — and never at ~/lawha-data.
 *
 * Assertions read the real scene through `window.h`, which is exposed in dev
 * and test builds only. That is deliberate: this repo has been burned by a
 * "drew a rectangle" check that counted `<canvas>` elements and passed on an
 * empty board, so nothing here asserts on a proxy for the artefact.
 */

const PASSWORD = "correct-horse-battery";
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

interface SceneProbe {
  /** Non-deleted elements carrying a Lawha grid tag. */
  cells: number;
  /** Distinct tableIds present. */
  tables: number;
  /** Distinct groupIds across those cells. */
  groups: number;
  selectedElementIds: number;
  selectedGroupIds: number;
  types: string[];
}

const probe = (page: Page): Promise<SceneProbe> =>
  page.evaluate(() => {
    const h = (window as unknown as { h?: any }).h;
    if (!h) {
      throw new Error(
        "window.h is unavailable — this spec needs a dev or test build",
      );
    }
    const all = h.elements.filter((el: any) => !el.isDeleted);
    const tagged = all.filter((el: any) => el.customData?.lawha);
    const state = h.state;
    return {
      cells: tagged.length,
      tables: new Set(tagged.map((el: any) => el.customData.lawha.tableId))
        .size,
      groups: new Set(tagged.flatMap((el: any) => el.groupIds ?? [])).size,
      selectedElementIds: Object.keys(state.selectedElementIds ?? {}).length,
      selectedGroupIds: Object.keys(state.selectedGroupIds ?? {}).length,
      types: Array.from(new Set(all.map((el: any) => el.type))).sort(),
    };
  });

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
    return id;
  }, name);
  return boardId;
};

/** Opens a board and waits for the editor to be genuinely interactive. */
const openBoard = async (page: Page, boardId: string) => {
  await page.goto(`/b/${boardId}`);
  await page.locator(".excalidraw").waitFor({ state: "visible" });
  await page.waitForFunction(() => !!(window as unknown as { h?: any }).h);
  await page.waitForTimeout(600);
};

/** Places a grid object from the toolbar, clicking the canvas at `at`. */
const placeFromToolbar = async (
  page: Page,
  tool: string,
  at = { x: 700, y: 420 },
) => {
  const button = page.locator(`[data-testid="lawha-tool-${tool}"]`);
  await button.waitFor({ state: "visible" });
  await button.click();
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(400);
};

test.describe("grid objects", () => {
  test.describe.configure({ mode: "serial" });

  let boardId: string;

  test.beforeEach(async ({ page }) => {
    await register(page, `grid${stamp()}`);
    boardId = await createBoard(page, "Grids");
    await openBoard(page, boardId);
  });

  test("a table is placed where the canvas is clicked", async ({ page }) => {
    await placeFromToolbar(page, "table");

    const scene = await probe(page);
    expect(scene.cells).toBe(12);
    expect(scene.tables).toBe(1);
    // Composed from ordinary shapes — the whole point of ADR 0023. A fresh
    // table is rectangles only: a cell gains its bound text when someone types
    // into it, exactly as an empty rectangle does.
    expect(scene.types).toEqual(["rectangle"]);
  });

  test("a cell takes text, and the text binds into that cell", async ({
    page,
  }) => {
    await placeFromToolbar(page, "table", { x: 700, y: 420 });
    // Deselect first, so the double-click lands on the cell rather than on the
    // group's selection box.
    await page.keyboard.press("Escape");
    await page.mouse.dblclick(700, 420);
    await page.keyboard.type("hello");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    const bound = await page.evaluate(() => {
      const h = (window as unknown as { h: any }).h;
      const text = h.elements.find(
        (el: any) => el.type === "text" && !el.isDeleted,
      );
      if (!text) {
        return null;
      }
      const container = h.elements.find(
        (el: any) => el.id === text.containerId,
      );
      return {
        text: text.text,
        inACell: !!container?.customData?.lawha,
      };
    });

    expect(bound).not.toBeNull();
    expect(bound!.text).toBe("hello");
    expect(bound!.inACell).toBe(true);
  });

  test("does not group the cells, and selects only one of them", async ({
    page,
  }) => {
    await placeFromToolbar(page, "table");

    const scene = await probe(page);
    // Grouping is what forced two double-clicks per cell. Cohesion comes from
    // the overlay's move bar instead.
    expect(scene.groups).toBe(0);
    expect(scene.selectedGroupIds).toBe(0);
    // One outline, not twelve.
    expect(scene.selectedElementIds).toBe(1);
  });

  test("one double-click starts typing in a cell", async ({ page }) => {
    // The whole point of dropping the group: filling a cell used to take two
    // double-clicks, because the first only entered the group.
    await placeFromToolbar(page, "table", { x: 700, y: 420 });
    await page.keyboard.press("Escape");
    await page.mouse.dblclick(700, 420);
    await page.waitForTimeout(400);

    expect(
      await page.evaluate(
        () => !!(window as unknown as { h: any }).h.state.editingTextElement,
      ),
    ).toBe(true);
  });

  test("the move bar drags the whole table", async ({ page }) => {
    await placeFromToolbar(page, "table", { x: 700, y: 420 });
    const before = await page.evaluate(() => {
      const h = (window as unknown as { h: any }).h;
      const cells = h.elements.filter(
        (el: any) => el.customData?.lawha && !el.isDeleted,
      );
      return { n: cells.length, minX: Math.min(...cells.map((c: any) => c.x)) };
    });

    const bar = page.locator('[data-testid="lawha-table-move"]');
    await bar.waitFor({ state: "visible" });
    const box = (await bar.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await page.waitForTimeout(400);

    const after = await page.evaluate(() => {
      const h = (window as unknown as { h: any }).h;
      const cells = h.elements.filter(
        (el: any) => el.customData?.lawha && !el.isDeleted,
      );
      return { n: cells.length, minX: Math.min(...cells.map((c: any) => c.x)) };
    });

    // Every cell came along, and none was left behind.
    expect(after.n).toBe(before.n);
    expect(after.minX).toBeGreaterThan(before.minX + 100);
  });

  test("a cell dragged out of the grid snaps back", async ({ page }) => {
    await placeFromToolbar(page, "table", { x: 700, y: 420 });
    await page.keyboard.press("Escape");

    const home = await page.evaluate(() => {
      const h = (window as unknown as { h: any }).h;
      const cell = h.elements.find(
        (el: any) =>
          el.customData?.lawha?.row === 1 && el.customData?.lawha?.col === 1,
      );
      return { id: cell.id, x: cell.x, y: cell.y };
    });

    // Drag that cell a long way off. Ungrouped, the editor allows it.
    await page.mouse.move(700, 420);
    await page.mouse.down();
    await page.mouse.move(1050, 700, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    const now = await page.evaluate((id) => {
      const h = (window as unknown as { h: any }).h;
      const cell = h.elements.find((el: any) => el.id === id);
      return { x: cell.x, y: cell.y };
    }, home.id);

    expect(Math.abs(now.x - home.x)).toBeLessThanOrEqual(6);
    expect(Math.abs(now.y - home.y)).toBeLessThanOrEqual(6);
  });

  test("one undo removes the whole table, one redo brings it back", async ({
    page,
  }) => {
    await placeFromToolbar(page, "table");
    expect((await probe(page)).cells).toBe(12);

    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    expect((await probe(page)).cells).toBe(0);

    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(400);
    const after = await probe(page);
    expect(after.cells).toBe(12);
    expect(after.tables).toBe(1);
  });

  test("undo of a table does not disturb what was already on the board", async ({
    page,
  }) => {
    // Draw a rectangle first, then insert and undo. The rectangle must survive
    // — "undo things mess up everything" is exactly this going wrong.
    await page.locator('[data-testid="toolbar-rectangle"]').click();
    await page.mouse.move(300, 250);
    await page.mouse.down();
    await page.mouse.move(430, 350);
    await page.mouse.up();
    await page.waitForTimeout(300);

    const before = await page.evaluate(
      () =>
        (window as unknown as { h: any }).h.elements.filter(
          (e: any) => !e.isDeleted,
        ).length,
    );
    expect(before).toBe(1);

    await placeFromToolbar(page, "table");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);

    const scene = await probe(page);
    expect(scene.cells).toBe(0);
    const survivors = await page.evaluate(
      () =>
        (window as unknown as { h: any }).h.elements.filter(
          (e: any) => !e.isDeleted,
        ).length,
    );
    expect(survivors).toBe(1);
  });

  test("data science mode reveals the extra tools, standard mode hides them", async ({
    page,
  }) => {
    // Table is general-purpose and always offered.
    await expect(
      page.locator('[data-testid="lawha-tool-table"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="lawha-tool-matrix"]')).toHaveCount(
      0,
    );

    await page.locator('[data-testid="lawha-mode-trigger"]').click();
    await page.locator('[data-testid="lawha-mode-datascience"]').click();
    await page.waitForTimeout(300);

    for (const tool of ["matrix", "tensor2d", "tensor3d"]) {
      await expect(
        page.locator(`[data-testid="lawha-tool-${tool}"]`),
      ).toBeVisible();
    }
  });

  test("a matrix places as one object and undoes in one step", async ({
    page,
  }) => {
    await page.locator('[data-testid="lawha-mode-trigger"]').click();
    await page.locator('[data-testid="lawha-mode-datascience"]').click();
    await placeFromToolbar(page, "matrix");

    const scene = await probe(page);
    expect(scene.cells).toBe(9);
    // A matrix is filled in like a table, so it is ungrouped for the same
    // reason.
    expect(scene.groups).toBe(0);

    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    expect((await probe(page)).cells).toBe(0);
  });

  test("a 3D tensor places as one object", async ({ page }) => {
    await page.locator('[data-testid="lawha-mode-trigger"]').click();
    await page.locator('[data-testid="lawha-mode-datascience"]').click();
    await placeFromToolbar(page, "tensor3d");

    const scene = await probe(page);
    // A tensor block IS one shape made of faces — nothing is typed into it, so
    // grouping costs nothing and keeps it moving as a unit.
    expect(scene.groups).toBe(1);
    expect(scene.types).toContain("line");

    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    expect((await probe(page)).cells).toBe(0);
  });

  test("the table survives a reload", async ({ page }) => {
    await placeFromToolbar(page, "table");
    await page.waitForTimeout(1200);

    await openBoard(page, boardId);
    const scene = await probe(page);
    expect(scene.cells).toBe(12);
    expect(scene.tables).toBe(1);
  });

  test("a code block places as one image and carries its source", async ({
    page,
  }) => {
    await placeFromToolbar(page, "code");

    const block = await page.evaluate(() => {
      const h = (window as unknown as { h: any }).h;
      const el = h.elements.find(
        (e: any) => e.customData?.lawha?.kind === "code" && !e.isDeleted,
      );
      return el
        ? {
            type: el.type,
            hasFile: !!el.fileId,
            source: el.customData.lawha.source,
            width: el.width,
          }
        : null;
    });

    expect(block).not.toBeNull();
    expect(block!.type).toBe("image");
    expect(block!.hasFile).toBe(true);
    // The picture is derived; the source is the thing that must not be lost.
    expect(block!.source.length).toBeGreaterThan(0);
    expect(block!.width).toBeGreaterThan(100);
  });

  test("editing the source re-renders the block in place", async ({ page }) => {
    await placeFromToolbar(page, "code");

    const before = await page.evaluate(() => {
      const h = (window as unknown as { h: any }).h;
      const el = h.elements.find(
        (e: any) => e.customData?.lawha?.kind === "code",
      );
      return { id: el.id, fileId: el.fileId };
    });

    await page.locator('[data-testid="lawha-code-edit"]').click();
    const area = page.locator('[data-testid="lawha-code-source"]');
    await area.waitFor({ state: "visible" });
    await area.fill("SELECT name FROM users WHERE id = 1;");
    await page
      .locator('[data-testid="lawha-code-language-select"]')
      .selectOption("sql");
    await page.locator('[data-testid="lawha-code-save"]').click();
    await page.waitForTimeout(500);

    const after = await page.evaluate(() => {
      const h = (window as unknown as { h: any }).h;
      const el = h.elements.find(
        (e: any) => e.customData?.lawha?.kind === "code" && !e.isDeleted,
      );
      return {
        id: el.id,
        fileId: el.fileId,
        source: el.customData.lawha.source,
        language: el.customData.lawha.language,
      };
    });

    // Same element, new picture — peers see one edit, not a delete and insert.
    expect(after.id).toBe(before.id);
    expect(after.fileId).not.toBe(before.fileId);
    expect(after.source).toContain("SELECT name");
    expect(after.language).toBe("sql");
  });

  test("a code block survives a reload, picture and all", async ({ page }) => {
    await placeFromToolbar(page, "code");
    await page.waitForTimeout(1500);

    await openBoard(page, boardId);
    const after = await page.evaluate(() => {
      const h = (window as unknown as { h: any }).h;
      const el = h.elements.find(
        (e: any) => e.customData?.lawha?.kind === "code" && !e.isDeleted,
      );
      return el
        ? { source: el.customData.lawha.source, fileId: el.fileId }
        : null;
    });

    expect(after).not.toBeNull();
    expect(after!.source.length).toBeGreaterThan(0);
    expect(after!.fileId).toBeTruthy();
  });

  test("one undo removes a code block", async ({ page }) => {
    await placeFromToolbar(page, "code");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);

    const remaining = await page.evaluate(
      () =>
        (window as unknown as { h: any }).h.elements.filter(
          (e: any) => e.customData?.lawha?.kind === "code" && !e.isDeleted,
        ).length,
    );
    expect(remaining).toBe(0);
  });
});
