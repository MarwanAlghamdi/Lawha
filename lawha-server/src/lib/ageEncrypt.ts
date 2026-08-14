import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `age`'s own format for an X25519 recipient (a PUBLIC key): the string
 * "age1" followed by 58 bech32 characters — always lowercase, `age-keygen`
 * never emits mixed case. This is the ONE place that pattern is written down;
 * `config.ts` imports it rather than re-typing it, because two copies of a
 * regex drift the moment one of them is "fixed" without the other.
 *
 * Anchored on both ends (`^`/`$`), not `test()`ed against a substring — a
 * recipient is pasted into `lawha.env` by hand, and an operator who fat-
 * fingers a trailing character or copies a stray quote deserves a refusal at
 * boot, not a corrupted key handed to `age` at 3am during the first backup.
 */
export const AGE_RECIPIENT_PATTERN = /^age1[0-9a-z]{58}$/;

/** `age --version` should return well inside this; it does no I/O. */
const AGE_VERSION_TIMEOUT_MS = 5_000;

/**
 * Generous on purpose: this wraps whatever `backup.mjs` hands it, which will
 * eventually be a multi-hundred-MB database artefact once Task 2 wires this
 * in. A short timeout that fires on a slow disk would turn "backup encrypted
 * a little late" into "backup silently never ran".
 */
const AGE_ENCRYPT_TIMEOUT_MS = 5 * 60_000;

/**
 * Whether the `age` binary can actually be invoked here.
 *
 * Never throws — this exists so a caller can decide what to do (encrypt,
 * refuse to start, log a warning) rather than catching a spawn error itself.
 * `encryptToRecipient` deliberately does NOT call this first: doing so would
 * create a TOCTOU gap (available here, gone by the time the real spawn runs)
 * that would be invisible unless a caller checked both return values, so the
 * one path that must never lie — encryption actually happening — always goes
 * through the real spawn and lets it fail on its own.
 */
export const isAgeAvailable = async (): Promise<boolean> => {
  try {
    await execFileAsync("age", ["--version"], {
      timeout: AGE_VERSION_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Encrypt `plaintext` to `recipient` by shelling out to `age -r <recipient>`.
 *
 * THE ONE RULE THIS FUNCTION EXISTS TO ENFORCE: every failure path rejects.
 * None of them may resolve with `plaintext`, or with anything that is not
 * genuinely `age`'s ciphertext. A backup pipeline that treats a rejected
 * promise as "oh well, ship the plaintext" would produce an archive that
 * LOOKS encrypted — same filename, same place in the tar, nobody watching —
 * and isn't, and the only way anyone finds out is by someone unauthorized
 * opening it. There is no code path below that swallows an error and returns
 * bytes; if that ever changes, it is this comment being violated, not
 * extended.
 *
 * `age` is invoked with the recipient only — never a private key, never
 * `-i` — because this process is exactly the one ADR 0020 says must
 * never be able to decrypt its own backups.
 */
export const encryptToRecipient = (
  plaintext: Buffer,
  recipient: string,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn("age", ["-r", recipient], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // NOT `spawn(..., { timeout: AGE_ENCRYPT_TIMEOUT_MS })`. Node's built-in
    // spawn timeout clears its kill-timer only on the child's `'exit'`
    // event — and a spawn failure (ENOENT because `age` is not installed,
    // EACCES, ...) never reaches `'exit'`, only `'error'`/`'close'`. That
    // left the correct, immediate rejection below sharing a process with a
    // timer that kept running for the full 5 minutes anyway: found by
    // review, reproduced both as a minimal `spawn()` against a missing
    // binary (`'close'` in ~5ms, `beforeExit` at 5000ms) and live in the
    // built image, where the container sat `Up (unhealthy)` long after
    // logging the rejection. Owning the timer here and clearing it on every
    // settle path — not just the timeout path — is the actual fix;
    // `unref()` below is belt-and-braces so a leaked timer, if one is ever
    // reintroduced, cannot keep the process alive on its own, but it is not
    // a substitute for the clearing.
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, AGE_ENCRYPT_TIMEOUT_MS);
    killTimer.unref();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    // `close` can fire after `error` (a process that failed to spawn still
    // emits both in some Node versions) and `stdin`'s own `error` can race
    // the child's `close`. One settle, first writer wins, so this can never
    // reject then resolve — or worse, resolve twice with different values.
    let settled = false;

    const fail = (message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      reject(new Error(`age encryption failed: ${message}`));
    };

    child.on("error", (error) => {
      // ENOENT (age not on PATH), EACCES, and friends. Not caught — allowed
      // to propagate as a rejection, because catching it here to build a
      // "friendlier" return value is exactly the shape of the bug this file
      // is not allowed to have.
      fail(`could not start "age": ${error.message}`);
    });

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // Ignore-and-let-close-report, not a second failure path. Once `age`
    // exits (bad recipient, refuses to start) it closes stdin from its end,
    // and Node fires EPIPE here on the write that has not landed yet. The
    // exit code + stderr the `close` handler below sees is the true reason;
    // without this handler the EPIPE would surface as an *unhandled* 'error'
    // event on the stream and crash the process instead of rejecting cleanly.
    child.stdin.on("error", () => {});

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      if (signal) {
        fail(
          timedOut
            ? `killed by ${signal} (timed out after ${AGE_ENCRYPT_TIMEOUT_MS}ms)`
            : `killed by ${signal}`,
        );
        return;
      }

      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        fail(`exited ${String(code)}${stderr ? ` — ${stderr}` : ""}`);
        return;
      }

      const ciphertext = Buffer.concat(stdoutChunks);

      // Belt-and-braces against the exact failure this file is written to
      // prevent: `age` exiting 0 with nothing on stdout is not a real
      // observed failure mode, but "exit 0, empty output, caller trusts it"
      // is precisely the shape that would look like a successful, silent
      // encryption of nothing. Refuse rather than hand back an empty Buffer
      // for a non-empty input.
      if (ciphertext.length === 0 && plaintext.length > 0) {
        fail("exited 0 but produced no output");
        return;
      }

      settled = true;
      clearTimeout(killTimer);
      resolve(ciphertext);
    });

    child.stdin.end(plaintext);
  });
