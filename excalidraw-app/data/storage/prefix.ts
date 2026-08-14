/**
 * Storage prefixes, kept in step with `parseFilePrefix` in
 * lawha-server/src/protocol.ts.
 *
 * The leading slash is tolerated because the app historically wrote
 * `/files/rooms/<id>` while reading `files/rooms/<id>`; both forms exist in
 * saved data and in older links.
 */
const RE_FILE_PREFIX = /^\/*files\/(rooms|shareLinks)\/([A-Za-z0-9_-]+)$/;

export type FileScope = "rooms" | "shareLinks";

export const parseFilePrefix = (
  prefix: string,
): { scope: FileScope; containerId: string } | null => {
  const match = prefix.match(RE_FILE_PREFIX);
  return match ? { scope: match[1] as FileScope, containerId: match[2] } : null;
};
