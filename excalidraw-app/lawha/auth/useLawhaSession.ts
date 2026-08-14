import { useCallback, useEffect } from "react";

import { atom, useAtom, appJotaiStore } from "../../app-jotai";
import { clearHistoryForUser } from "../../data/undoHistory";

import {
  fetchCurrentUser,
  fetchServerConfig,
  signIn as signInRequest,
  signOut as signOutRequest,
  signUp as signUpRequest,
} from "./authApi";

import type { LawhaServerConfig, LawhaUser } from "./authApi";

export type LawhaSessionStatus =
  /** The first /auth/me is still in flight; render nothing identity-shaped. */
  | "loading"
  | "authenticated"
  /** No session. Either the sign-in screen, or anonymous use on an open server. */
  | "anonymous";

export interface LawhaSessionState {
  status: LawhaSessionStatus;
  user: LawhaUser | null;
  /**
   * True when an administrator opened this session with the master password
   * rather than the account's own. Surfaced so acting as someone else is never
   * silent — the account panel says so in as many words.
   */
  viaMaster: boolean;
  /**
   * A master-password administration session is open.
   *
   * Deliberately separate from `user` and from `status`: this is not an
   * account, so `status` stays `anonymous` and `user` stays null. Only the
   * `/admin` guard reads it, which is the same shape the server has — one flag,
   * honoured by one router.
   */
  masterAdmin: boolean;
  /**
   * Null until the first load resolves, and null again if the server could not
   * be reached — so callers must treat "unknown" as distinct from "open".
   */
  config: LawhaServerConfig | null;
}

const INITIAL: LawhaSessionState = {
  status: "loading",
  user: null,
  viaMaster: false,
  masterAdmin: false,
  config: null,
};

export const sessionAtom = atom<LawhaSessionState>(INITIAL);

/**
 * Deduplicates the initial load. Every route that needs identity calls the
 * hook, and in the canvas several components do at once; without this each
 * mount would fire its own /auth/me on first paint.
 */
let inFlight: Promise<LawhaSessionState> | null = null;

const load = (): Promise<LawhaSessionState> => {
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    // Settled, not raced: an unreachable config endpoint must not stop the app
    // from learning it has a session, and vice versa.
    const [me, config] = await Promise.all([
      fetchCurrentUser().catch(() => null),
      fetchServerConfig().catch(() => null),
    ]);

    const next: LawhaSessionState = {
      // `me.user`, not `me`. A master-password session resolves to a `me` with
      // no user in it, and calling that "authenticated" would send it into
      // `RequireSession` and every board route behind it.
      status: me?.user ? "authenticated" : "anonymous",
      user: me?.user ?? null,
      viaMaster: me?.viaMaster === true,
      masterAdmin: me?.masterAdmin === true,
      config,
    };

    appJotaiStore.set(sessionAtom, next);

    return next;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
};

/** Applies a known user to the shared session without a round trip. */
const adopt = (user: LawhaUser | null) => {
  appJotaiStore.set(sessionAtom, (previous) => ({
    ...previous,
    status: user ? "authenticated" : "anonymous",
    user,
  }));
};

export interface LawhaSession extends LawhaSessionState {
  refresh: () => Promise<LawhaSessionState>;
  signIn: (username: string, password: string) => Promise<LawhaUser>;
  signUp: (username: string, password: string) => Promise<LawhaUser>;
  signOut: () => Promise<void>;
  /** Called after a profile PATCH so every surface sees the new name at once. */
  setUser: (user: LawhaUser | null) => void;
}

export const useLawhaSession = (): LawhaSession => {
  const [state] = useAtom(sessionAtom);

  useEffect(() => {
    if (state.status === "loading") {
      void load();
    }
  }, [state.status]);

  const signIn = useCallback(async (username: string, password: string) => {
    const user = await signInRequest(username, password);
    adopt(user);
    // **Nothing is derived from the password here any more.** This used to
    // call `openEscrow`, because deriving a master key at sign-in was the only
    // moment the password was in hand and there was no second chance — which
    // is exactly why a session restored from a cookie could not open the
    // account's own boards, and why the app grew a screen asking for the
    // password again (ADR 0012 removed both).
    return user;
  }, []);

  const signUp = useCallback(async (username: string, password: string) => {
    const user = await signUpRequest(username, password);
    adopt(user);
    // No escrow to set up. A new account mints no key material of any kind:
    // its boards are plaintext from the first save (ADR 0012, migration 013).
    return user;
  }, []);

  const signOut = useCallback(async () => {
    // Read the atom directly rather than close over this render's `state`, the
    // same way `adopt` and `load` do. A `useCallback` dep on `state.user?.id`
    // would only be current for whichever render last produced this exact
    // closure — fine for the common case, but the one caller that matters
    // here is a click that can land an arbitrary amount of time after the
    // render that created it, and a stale id would silently skip clearing the
    // very history whose deletion is this feature's entire privacy story.
    const userId = appJotaiStore.get(sessionAtom).user?.id ?? null;
    await signOutRequest();
    adopt(null);
    // After the session is gone, not before: if `signOutRequest` throws, both
    // `adopt(null)` and this are skipped, so a failed sign-out never leaves
    // the person signed in with their history already deleted.
    if (userId) {
      await clearHistoryForUser(userId);
    }
  }, []);

  return {
    ...state,
    refresh: load,
    signIn,
    signUp,
    signOut,
    setUser: adopt,
  };
};

/** Test seam: drops the cached session so the next hook call reloads. */
export const resetLawhaSession = () => {
  inFlight = null;
  appJotaiStore.set(sessionAtom, INITIAL);
};
