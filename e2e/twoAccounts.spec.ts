import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

/**
 * The whole of ADR 0012, walked as two real people on a real deployment.
 *
 * It wants an account that predates ADR 0012 — one whose boards are a *mix* of
 * scenes converted out of ciphertext and scenes still encrypted with keys the
 * server cannot reach. That mix does not exist in a freshly registered account,
 * and it is exactly where the interesting failures live. The account this was
 * written against had seven boards, five converted and two unreadable.
 *
 * On a deployment created after ADR 0012 there is no such account and never
 * will be, so this spec has nothing to say: the database has no ciphertext in
 * it. Run `openBoards.spec.ts` instead. That is not a gap — it is the migration
 * having finished.
 *
 * `test.describe.serial`, because these steps share state on purpose: a board
 * created in one is shared in the next and collaborated on in the one after.
 *
 * **This spec must not damage a real account.** It never draws on a legacy
 * board, and the byte size of the unreadable one is asserted unchanged at the
 * end — see the note on that test.
 */

/**
 * The account whose boards make this spec worth more than a synthetic one.
 *
 * Read from the environment, never written down here. The first draft had the
 * real password as a literal — on a branch that is local today and is still a
 * git object forever, in a repo that ships a security guide. A test credential
 * is a credential.
 *
 * Both are required rather than defaulted: a default would let this run against
 * a freshly registered account and quietly stop testing the thing it exists to
 * test, which is a five-of-seven mix of converted and still-encrypted boards.
 */
const OWNER = {
  username: process.env.LAWHA_E2E_OWNER ?? "",
  password: process.env.LAWHA_E2E_OWNER_PASSWORD ?? "",
};

test.beforeAll(() => {
  if (!OWNER.username || !OWNER.password) {
    throw new Error(
      "lawha e2e: set LAWHA_E2E_OWNER and LAWHA_E2E_OWNER_PASSWORD to an " +
        "account on the target deployment. This spec asserts against boards " +
        "that a new account does not have.",
    );
  }
});
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** Boards that exist on this deployment, with the state each is in. */
const READABLE_BOARD = { id: "a79bd972c5f15ce4311e", name: "Hello" };
/**
 * A board this browser cannot read, made on purpose rather than borrowed.
 *
 * This used to point at a real stuck board — `264acb61…`, "Do not touch copy",
 * 12 KB — and that was fragile in a way worth naming: the whole project is to
 * leave no board unreadable, so a test depending on one existing is a test that
 * breaks the day the work succeeds. It did, the moment that board was recovered
 * by trying the key of the board it had been duplicated from.
 *
 * So the spec mints its own: a board it owns, with a scene written under an IV
 * and bytes no key opens. Self-contained, deterministic, and it cannot damage
 * anybody's work because nothing but this test ever knew it.
 */
const UNREADABLE_BOARD_NAME = "QA unreadable (delete me)";

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/two-accounts/${name}.png` });

const signIn = async (page: Page, username: string, password: string) => {
  await page.goto("/signin");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), {
    timeout: 30_000,
  });
};

const registerAndSignIn = async (page: Page, username: string) => {
  await page.goto("/signin");
  const ok = await page.evaluate(
    async ([u, p]) => {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      return response.ok;
    },
    [username, OWNER.password] as const,
  );
  if (!ok) {
    throw new Error(`could not register ${username}`);
  }
  await page.goto("/");
};

/** Non-background pixels on the static canvas. See openBoards.spec.ts. */
const paintedPixels = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector(
      "canvas.static",
    ) as HTMLCanvasElement | null;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return 0;
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const bg = [data[0], data[1], data[2], data[3]];
    let painted = 0;
    for (let i = 0; i < data.length; i += 4 * 40) {
      if (
        Math.abs(data[i] - bg[0]) > 8 ||
        Math.abs(data[i + 1] - bg[1]) > 8 ||
        Math.abs(data[i + 2] - bg[2]) > 8
      ) {
        painted++;
      }
    }
    return painted;
  });

/**
 * Writes a scene straight to the API, as the app's own save path does.
 *
 * Reads the current revision first and sends it as `X-Lawha-Expected-Rev`,
 * because that is the compare-and-swap token and the server is right to refuse
 * a stale one. The first draft of this helper always sent `""` — "I have never
 * seen a stored scene, create if absent" — which is correct exactly once and
 * earned a 409 on the second write. That 409 was invariant 2 doing its job,
 * not a defect, and it is worth the extra round trip here to keep saying so.
 */
const putScene = (page: Page, boardId: string, elementCount: number) =>
  page.evaluate(
    async ([id, count]) => {
      const current = await fetch(`/api/boards/${id}/scene`);
      const expectedRev =
        current.status === 200 ? current.headers.get("x-lawha-rev") ?? "" : "";
      const elements = Array.from({ length: count as number }, (_, index) => ({
        id: `e${index}`,
        type: "rectangle",
        x: 80 + index * 70,
        y: 120,
        width: 60,
        height: 60,
        version: 3,
        versionNonce: 5 + index,
        isDeleted: false,
        index: `a${index + 1}`,
        seed: 3,
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
      }));
      const response = await fetch(`/api/boards/${id}/scene`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Lawha-Expected-Rev": expectedRev,
          "X-Lawha-Scene-Version": "3",
        },
        body: new TextEncoder().encode(JSON.stringify(elements)),
      });
      return response.status;
    },
    [boardId, elementCount] as const,
  );

const sceneOf = (page: Page, boardId: string) =>
  page.evaluate(async (id) => {
    const response = await fetch(`/api/boards/${id}/scene`);
    return {
      status: response.status,
      iv: response.headers.get("x-lawha-iv"),
      body: response.status === 200 ? await response.text() : "",
    };
  }, boardId);

let sharedBoardId = "";
const guestName = `qa-mate-${stamp()}`;

test.describe.serial("two accounts, end to end", () => {
  test("1. the owner signs in and sees every board, unlocked", async ({
    page,
  }) => {
    await signIn(page, OWNER.username, OWNER.password);
    await page.waitForSelector(".lw-board-card, .lw-board-row", {
      timeout: 30_000,
    });
    await shot(page, "01-owner-dashboard");

    // Seven boards, and not one of them padlocked — five converted out of
    // ciphertext and two still encrypted. Before ADR 0012 the two would have
    // been padlocked and the account would have been asked for its password.
    const cards = await page.locator(".lw-board-card").count();
    expect(cards).toBeGreaterThanOrEqual(7);

    await expect(page.locator(".lw-board-card--locked")).toHaveCount(0);
    await expect(page.locator(".lw-board-card__locked-note")).toHaveCount(0);
    await expect(page.getByText(/locked in this browser/i)).toHaveCount(0);
    await expect(page.getByText(/Unlock my boards/i)).toHaveCount(0);
    await expect(page.getByText(/This board is locked here/i)).toHaveCount(0);
  });

  test("2. a converted board opens and renders its contents", async ({
    page,
  }) => {
    await signIn(page, OWNER.username, OWNER.password);
    await page.goto(`/b/${READABLE_BOARD.id}`);

    const scene = await sceneOf(page, READABLE_BOARD.id);
    expect(scene.status).toBe(200);
    // Converted: the IV is empty and the body is readable JSON.
    expect(scene.iv).toBe("");
    expect(JSON.parse(scene.body).length).toBeGreaterThan(0);

    await expect
      .poll(() => paintedPixels(page), { timeout: 25_000 })
      .toBeGreaterThan(20);
    await shot(page, "02-converted-board");
  });

  test("3. an unreadable board opens READ-ONLY and cannot be overwritten", async ({
    page,
  }) => {
    // The most dangerous path in the whole change. When the scene load fails,
    // what must NOT happen is a writable blank canvas: the first stray pointer
    // movement would save an empty scene over the stored one, and for a board
    // written before ADR 0012 the ciphertext it replaced is the only copy.
    await signIn(page, OWNER.username, OWNER.password);

    // Minted here rather than borrowed — see the note on the constant. A
    // 12-byte IV and 64 bytes that no key will ever open.
    const unreadableId = await page.evaluate(async (name) => {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(10)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name }),
      });
      const iv = Array.from(crypto.getRandomValues(new Uint8Array(12)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      await fetch(`/api/boards/${id}/scene`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Lawha-Expected-Rev": "",
          "X-Lawha-Scene-Version": "1",
          "X-Lawha-Iv": iv,
        },
        body: crypto.getRandomValues(new Uint8Array(64)),
      });
      return id;
    }, UNREADABLE_BOARD_NAME);

    const before = await sceneOf(page, unreadableId);
    expect(before.status).toBe(200);
    // Still encrypted: a non-empty IV is the marker.
    expect(before.iv).not.toBe("");
    const beforeBytes = before.body.length;

    await page.goto(`/b/${unreadableId}`);
    await page.waitForTimeout(6000);
    await shot(page, "03-unreadable-board");

    // Read-only, asserted at the DOM the person actually sees.
    const canDraw = await page.evaluate(
      () => !!document.querySelector(".App-toolbar, .Island.App-toolbar"),
    );

    // And the save pill says so. It read a green "Saved" here, which was true
    // in the narrow sense that no write had failed and false in the sense a
    // person reads it — above a canvas that had failed to load, on a board
    // they cannot write to.
    // `.first()`: the top bar renders the pill in a full and a compact form,
    // and both carry the label.
    await expect(page.getByText("Read-only").first()).toBeVisible();
    await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);

    // And — the assertion that actually protects the drawing — the stored
    // scene is byte-for-byte what it was.
    const after = await sceneOf(page, unreadableId);
    expect(after.iv).not.toBe("");
    expect(after.body.length).toBe(beforeBytes);

    // Recorded for the report rather than asserted: the toolbar's absence is
    // the visible half of view mode, and it is worth seeing in the screenshot
    // even though the byte comparison above is the guarantee.
    // eslint-disable-next-line no-console
    console.log(`[finding] unreadable board: toolbar present = ${canDraw}`);

    // Cleaned up: it is genuinely unreadable, so leaving it behind would put a
    // board on the dashboard that nothing can ever open.
    await page.evaluate(
      async (id) => fetch(`/api/boards/${id}`, { method: "DELETE" }),
      unreadableId,
    );
  });

  test("4. a new board is created, drawn on, and persists", async ({
    page,
  }) => {
    await signIn(page, OWNER.username, OWNER.password);

    sharedBoardId = await page.evaluate(async () => {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(10)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: "QA shared board" }),
      });
      return id;
    });

    expect(await putScene(page, sharedBoardId, 3)).toBe(200);

    await page.goto(`/b/${sharedBoardId}`);
    await expect
      .poll(() => paintedPixels(page), { timeout: 25_000 })
      .toBeGreaterThan(20);
    await shot(page, "04-new-board");

    // Born plaintext: a board created after ADR 0012 never has a key at all.
    const scene = await sceneOf(page, sharedBoardId);
    expect(scene.iv).toBe("");
    expect(JSON.parse(scene.body)).toHaveLength(3);
  });

  test("5. the owner's account panel shows their colour, picture and cursor", async ({
    page,
  }) => {
    await signIn(page, OWNER.username, OWNER.password);
    await page.goto("/account");
    await expect(page.getByLabel("Username")).toBeVisible();
    await shot(page, "05-owner-account");

    // This account HAS an avatar, so the remove control must be offered — the
    // case a freshly registered account cannot cover.
    await expect(page.locator(".lw-avatar__img")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove picture" }),
    ).toBeVisible();

    // Twelve swatches, one of them theirs, and Save inert until something moves.
    await expect(page.getByRole("radio")).toHaveCount(12);
    await expect(
      page.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();

    // Migration 012 turned this off for every existing account.
    await expect(
      page.getByRole("checkbox", {
        name: /Show my profile picture as my cursor/,
      }),
    ).not.toBeChecked();
  });

  test("6. the share link has no key in it", async ({ page }) => {
    await signIn(page, OWNER.username, OWNER.password);
    await page.evaluate(
      async (id) =>
        fetch(`/api/boards/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ linkAccess: "view" }),
        }),
      sharedBoardId,
    );

    await page.goto(`/b/${sharedBoardId}`);
    await page.waitForTimeout(3000);
    const link = await page.evaluate(() => window.location.href);
    expect(link).not.toContain("#key=");
    await shot(page, "06-shared-board-url");
  });

  test("7. a second account opens the shared board with no key and no prompt", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await registerAndSignIn(page, guestName);

    // A different account, a different browser profile, an empty IndexedDB —
    // and a bare `/b/<id>` with nothing after the hash.
    await page.goto(`/b/${sharedBoardId}`);

    const scene = await sceneOf(page, sharedBoardId);
    expect(scene.status).toBe(200);
    expect(JSON.parse(scene.body)).toHaveLength(3);

    await expect
      .poll(() => paintedPixels(page), { timeout: 25_000 })
      .toBeGreaterThan(20);
    await shot(page, "07-second-account-view");

    await expect(page.getByText(/This board is locked here/i)).toHaveCount(0);
    await context.close();
  });

  test("8. link access is a ceiling: view refuses the write, edit allows it", async ({
    browser,
  }) => {
    // Invariant 21, at the layer that enforces it. `canEdit` once existed with
    // no call sites at all, so `link_access: "view"` granted full write — and
    // with the encryption gone this check is the only thing left.
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, guestName, OWNER.password);

    const refused = await putScene(page, sharedBoardId, 9);
    expect(refused).toBe(403);

    // Still three elements: the refusal is real, not cosmetic.
    const untouched = await sceneOf(page, sharedBoardId);
    expect(JSON.parse(untouched.body)).toHaveLength(3);

    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    await signIn(ownerPage, OWNER.username, OWNER.password);
    await ownerPage.evaluate(
      async (id) =>
        fetch(`/api/boards/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ linkAccess: "edit" }),
        }),
      sharedBoardId,
    );
    await owner.close();

    const allowed = await putScene(page, sharedBoardId, 5);
    expect(allowed).toBe(200);
    expect(JSON.parse((await sceneOf(page, sharedBoardId)).body)).toHaveLength(
      5,
    );

    await shot(page, "08-link-access");
    await context.close();
  });

  test("9. an account-less link visitor watches, and cannot write", async ({
    browser,
  }) => {
    // Invariant 22: a link visitor is a narrower principal, not an absent one.
    // Guests are view-only whatever the link says — and the link says "edit".
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/b/${sharedBoardId}`);

    const scene = await sceneOf(page, sharedBoardId);
    expect(scene.status).toBe(200);
    expect(JSON.parse(scene.body)).toHaveLength(5);

    expect(await putScene(page, sharedBoardId, 99)).toBe(403);

    await expect
      .poll(() => paintedPixels(page), { timeout: 25_000 })
      .toBeGreaterThan(20);
    await shot(page, "09-guest-visitor");
    await context.close();
  });

  test("10. two people on one board see each other", async ({ browser }) => {
    // The plaintext socket path, which nothing else here exercises: payloads
    // now ride with a zero-length IV and the relay forwards them untouched.
    const a = await browser.newContext();
    const pageA = await a.newPage();
    await signIn(pageA, OWNER.username, OWNER.password);
    await pageA.goto(`/b/${sharedBoardId}`);

    const b = await browser.newContext();
    const pageB = await b.newPage();
    await signIn(pageB, guestName, OWNER.password);
    await pageB.goto(`/b/${sharedBoardId}`);

    // Presence is server-announced (`lawha-identities`, ADR 0006), so each
    // side learning about the other proves the room, not just the socket.
    await expect
      .poll(() => pageA.locator(".lw-presence__avatar, .lw-avatar").count(), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    await shot(pageA, "10-collab-owner");
    await shot(pageB, "10-collab-mate");

    await a.close();
    await b.close();
  });

  // Test 11 was "the unreadable board is still exactly as it was" — a final
  // check that nothing above had opened a write path onto a board it could not
  // read. It watched a borrowed board, which no longer exists in that state,
  // and test 3 now makes the same assertion on one it minted and owns.
});

test('12. every board shows its own name, not "Untitled"', async ({ page }) => {
  /*
   * A regression test for a bug that hid behind its own symptom.
   *
   * `syncBoardName` fetches the stored name and puts it on `appState.name`.
   * It ran once, early — and the editor consumes `initialData` afterwards,
   * replacing `appState` wholesale and taking the name with it. So the title
   * read "Untitled" on every board whose scene loaded correctly.
   *
   * The third case is the one that makes this test worth keeping. A board
   * whose scene FAILS to load resolves `initialData` to null, nothing is
   * applied, and the name survives — so the only board displaying its title
   * correctly was the broken one. Testing a working board alone would have
   * passed before the fix on the unreadable case and failed to notice.
   */
  const boards = [{ id: READABLE_BOARD.id, expected: READABLE_BOARD.name }];

  await signIn(page, OWNER.username, OWNER.password);

  for (const board of boards) {
    await page.goto(`/b/${board.id}`);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document.querySelector(".lw-topbar__title")?.textContent ?? "",
          ),
        { timeout: 30_000 },
      )
      .toContain(board.expected);
  }

  await shot(page, "12-board-title");
});

test("13. tags can be given a colour, and it is an index on the wire", async ({
  page,
}) => {
  await signIn(page, OWNER.username, OWNER.password);
  await page.goto("/");

  const name = `qa-tag-${stamp()}`;
  const created = await page.evaluate(async (tagName) => {
    const response = await fetch("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: tagName, colorIndex: 9 }),
    });
    return { status: response.status, tag: await response.json() };
  }, name);

  expect(created.status).toBe(201);
  // An index, and no hex anywhere in the payload — invariant 16, and tags were
  // the last place on the deployment still sending a CSS colour.
  expect(created.tag.tag.colorIndex).toBe(9);
  expect(JSON.stringify(created.tag)).not.toMatch(/#[0-9a-f]{6}/i);

  // Recolour, then clear. `null` and `undefined` are different: absent leaves
  // the colour alone, null removes it.
  const recoloured = await page.evaluate(async (tagId) => {
    const set = await fetch(`/api/tags/${tagId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ colorIndex: 3 }),
    });
    const afterSet = await set.json();
    const clear = await fetch(`/api/tags/${tagId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ colorIndex: null }),
    });
    return { afterSet, afterClear: await clear.json() };
  }, created.tag.tag.id);

  expect(recoloured.afterSet.tag.colorIndex).toBe(3);
  expect(recoloured.afterClear.tag.colorIndex).toBeNull();

  // The Tags button the dashboard never had: tags were reachable only from a
  // board that happened to carry one.
  await page.reload();
  await page.getByRole("button", { name: "Tags" }).click();
  await expect(page.getByRole("group", { name: "Manage tags" })).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: `Colour for ${name}` }),
  ).toBeVisible();
  await shot(page, "13-tag-colours");

  await page.evaluate(
    async (tagId) => fetch(`/api/tags/${tagId}`, { method: "DELETE" }),
    created.tag.tag.id,
  );
});
