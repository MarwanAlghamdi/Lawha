/**
 * The one string helper the dashboard's three report surfaces share.
 *
 * It lives in its own module rather than being copied into the transfer report,
 * the folder rail and the selection bar, because all three of them count boards
 * and a "1 boards" in a delete confirmation is the kind of thing that makes a
 * user distrust the count itself.
 */
export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
