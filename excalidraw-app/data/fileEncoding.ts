import { decompressData } from "@excalidraw/excalidraw/data/encode";
import { deflate, inflate } from "pako";

import type { BinaryFileMetadata } from "@excalidraw/excalidraw/types";

/**
 * The container an uploaded image travels in, now that files are not encrypted.
 *
 * **Why a Lawha-local format instead of upstream's.** `compressData` in
 * `packages/excalidraw/data/encode.ts` takes an `encryptionKey` and has no way
 * to be told not to use one, and its framing helpers — `concatBuffers`,
 * `splitBuffers`, `dataView` — are module-private. Making files plaintext
 * through that module would mean either exporting three internals or adding an
 * option to it, and both are new divergence in `packages/`. **Invariant 10 caps
 * that divergence at four files**, it is what keeps upstream merges tractable,
 * and the roadmap already records it running over (known issue 20). So the
 * write path lives here and `packages/` is not touched.
 *
 * **The read path still delegates**, and must: every file uploaded before ADR
 * 0012 is in upstream's container, and `decompressData` is exported and works.
 * A legacy file is recognised by its own bytes rather than by anything stored
 * alongside it, so nothing has to be migrated for one to keep opening.
 *
 * The layout, which is deliberately dull:
 *
 *     [ 8 bytes  ] magic, "LWFILE01"
 *     [ 4 bytes  ] metadata length, uint32 big-endian
 *     [ n bytes  ] metadata, JSON, UTF-8
 *     [ rest     ] deflate(dataURL bytes)
 *
 * Deflated for the same reason upstream deflates: the payload is a base64
 * data URL, which is text, and `FILE_UPLOAD_MAX_BYTES` is checked against what
 * actually goes over the wire. Dropping the compression along with the
 * encryption would have quietly cut the largest image anyone can paste.
 */

/** ASCII "LWFILE01". Eight bytes, so the version rides along with the magic. */
const MAGIC = new Uint8Array([0x4c, 0x57, 0x46, 0x49, 0x4c, 0x45, 0x30, 0x31]);

const METADATA_LENGTH_BYTES = 4;
const HEADER_BYTES = MAGIC.length + METADATA_LENGTH_BYTES;

const hasMagic = (buffer: Uint8Array): boolean => {
  if (buffer.byteLength < HEADER_BYTES) {
    return false;
  }
  return MAGIC.every((byte, index) => buffer[index] === byte);
};

export const encodeFile = (
  data: Uint8Array,
  metadata: BinaryFileMetadata,
): Uint8Array<ArrayBuffer> => {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const body = deflate(data);

  const out = new Uint8Array(
    new ArrayBuffer(HEADER_BYTES + metadataBytes.byteLength + body.byteLength),
  );
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, metadataBytes.byteLength);
  out.set(metadataBytes, HEADER_BYTES);
  out.set(body, HEADER_BYTES + metadataBytes.byteLength);

  return out;
};

/**
 * Reads a file back, in whichever container it was written.
 *
 * `decryptionKey` is consulted only on the legacy branch, and is allowed to be
 * null because a board created since ADR 0012 has no key at all. A legacy file
 * on a board whose key cannot be obtained throws rather than returning empty —
 * an image that silently resolves to nothing is the "reported as a different
 * bug entirely" failure this codebase keeps hitting.
 */
export const decodeFile = async (
  buffer: Uint8Array,
  decryptionKey: string | null,
): Promise<{ data: Uint8Array; metadata: BinaryFileMetadata }> => {
  if (!hasMagic(buffer)) {
    if (!decryptionKey) {
      throw new Error(
        "lawha: this image was stored encrypted and this board has no key for it",
      );
    }
    const legacy = await decompressData<BinaryFileMetadata>(buffer, {
      decryptionKey,
    });
    return { data: legacy.data, metadata: legacy.metadata };
  }

  const metadataLength = new DataView(
    buffer.buffer,
    buffer.byteOffset,
  ).getUint32(MAGIC.length);

  const metadata = JSON.parse(
    new TextDecoder().decode(
      buffer.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength),
    ),
  ) as BinaryFileMetadata;

  return {
    data: inflate(buffer.subarray(HEADER_BYTES + metadataLength)),
    metadata,
  };
};
