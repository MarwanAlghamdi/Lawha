import {
  COLLABORATOR_PALETTE,
  getCollaboratorPaletteIndex,
} from "@excalidraw/common";
import { THEME } from "@excalidraw/excalidraw";
import { useRef, useState } from "react";

import { useAppTheme } from "../../useHandleAppTheme";
import {
  changePassword,
  deleteAccount,
  deleteAvatar,
  updateProfile,
  uploadAvatar,
  avatarUrl,
  AVATAR_MIME_TYPES,
  LawhaApiError,
} from "../auth/authApi";
import { useLawhaSession } from "../auth/useLawhaSession";
import { LawhaField } from "../pages/LawhaField";

import "./LawhaAccount.scss";

import type { LawhaUser } from "../auth/authApi";

/** Matches the server's floor. It was 10 here and 8 everywhere else. */
const MIN_PASSWORD_LENGTH = 8;

/** Exactly what `PATCH /api/auth/me` accepts, so a new field cannot be missed. */
type ProfilePatch = Parameters<typeof updateProfile>[0];

/**
 * Normalised rather than read straight off the account.
 *
 * A server that predates migration 005 does not send the field at all, and
 * `checked={undefined}` is how React quietly turns a controlled checkbox back
 * into an uncontrolled one the first time it is clicked — a toggle that looks
 * live and saves nothing.
 *
 * Still `=== true` after 009 moved the *server's* default to on, and the
 * asymmetry is deliberate. Absent means "this server does not have the column",
 * not "this server has it and set it" — a client that read a missing field as
 * on would draw a checked box for a preference the server will never honour.
 */
const avatarOnCursorOf = (account: LawhaUser): boolean =>
  account.avatarOnCursor === true;

interface LawhaAccountPanelProps {
  /** Called after the account is deleted or the user signs out. */
  onSignedOut?: () => void;
}

const messageOf = (error: unknown, fallback: string) =>
  error instanceof LawhaApiError || error instanceof Error
    ? error.message
    : fallback;

const initialsOf = (username: string) =>
  [...username.trim()].slice(0, 2).join("").toUpperCase() || "?";

/**
 * The account surface itself, with no opinion about where it is rendered.
 *
 * It appears twice: as a dialog inside the canvas — the brief puts account
 * settings in the consolidated UI, and the canvas is the only screen that
 * exists today — and as the body of `/account`, for arriving from a link or
 * from the Phase 3 dashboard where there is no canvas to sit inside.
 */
export const LawhaAccountPanel = ({ onSignedOut }: LawhaAccountPanelProps) => {
  const { user } = useLawhaSession();

  if (!user) {
    return null;
  }

  // Keyed on the account so the form's state is initialised from a real user on
  // its very first render. Initialising from a possibly-null user and syncing
  // in an effect left one frame where the name field was empty but the account
  // was loaded — long enough for "Save changes" to be enabled and, if clicked,
  // to PATCH an empty username.
  return <AccountForm key={user.id} onSignedOut={onSignedOut} />;
};

const AccountForm = ({ onSignedOut }: LawhaAccountPanelProps) => {
  const { user, viaMaster, setUser, refresh } = useLawhaSession();
  const { editorTheme } = useAppTheme();

  const [username, setUsername] = useState(user?.username ?? "");
  const [avatarOnCursor, setAvatarOnCursor] = useState(
    user ? avatarOnCursorOf(user) : false,
  );
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isRemovingAvatar, setIsRemovingAvatar] = useState(false);

  /**
   * The swatch this form has picked, or null for "nothing picked yet".
   *
   * **Nullable on purpose, and it is the whole of the dirty-tracking here.**
   * An account that predates `color_index` has none on record and is *shown*
   * one hashed from its id, exactly as the old read-only dot was. Seeding this
   * with that fallback instead of with null would make the form dirty the
   * instant it loaded — Save enabled on a page nobody had touched, and every
   * later save silently carrying a `colorIndex` the user never chose.
   *
   * Held apart from the index actually rendered, below, so that clicking the
   * swatch already on screen still counts as a change: it turns a colour the
   * account merely happens to display into one it has chosen.
   */
  const [pickedIndex, setPickedIndex] = useState<number | null>(
    user?.colorIndex ?? null,
  );

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // The delete flow clears the session while this form is still mounted.
  if (!user) {
    return null;
  }

  // What the swatches and the avatar preview actually render: the pick if
  // there is one, else the stored colour, else the hash of the account id —
  // the same fallback the read-only dot used, so an account with nothing on
  // record still sees the colour its cursor really is.
  const colorIndex =
    pickedIndex ?? user.colorIndex ?? getCollaboratorPaletteIndex(user.id);
  const paletteEntry = COLLABORATOR_PALETTE[colorIndex];
  const avatarColor =
    editorTheme === THEME.DARK ? paletteEntry.hexDark : paletteEntry.hex;
  const picture = avatarUrl(user.id, user.avatarId);

  /**
   * What this form would send, and — from the same object — whether it has
   * anything to send at all.
   *
   * ADR 0003 records the bug this shape exists to prevent. The form used to
   * mark `laserColorIndex` dirty and then build its PATCH body from `username`
   * and `colorIndex` only, so changing nothing but the laser colour sent `{}`
   * and the server answered 400 "Nothing to update". A setting that cannot be
   * saved is worse than one that is missing, and the two could only disagree
   * because they were two computations. Deriving the flag *from* the body makes
   * that impossible: if a field is not in here, the button is not enabled.
   */
  const profileChanges: ProfilePatch = {};
  if (username.trim() !== user.username) {
    profileChanges.username = username.trim();
  }
  if (avatarOnCursor !== avatarOnCursorOf(user)) {
    profileChanges.avatarOnCursor = avatarOnCursor;
  }
  // Compared against the *stored* value, not against the fallback the picker
  // renders: an account with `color_index` null is showing a hashed colour it
  // does not actually have, and picking that same swatch deliberately IS a
  // change — it puts the choice on record. `!== user.colorIndex` says that,
  // where `!== paletteIndex` would silently discard it.
  if (pickedIndex !== null && pickedIndex !== user.colorIndex) {
    profileChanges.colorIndex = pickedIndex;
  }
  const isProfileDirty = Object.keys(profileChanges).length > 0;

  const onSaveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSavingProfile || !isProfileDirty) {
      return;
    }

    setProfileError(null);
    setProfileSaved(false);
    setIsSavingProfile(true);
    try {
      const updated = await updateProfile(profileChanges);
      setUser(updated);
      setProfileSaved(true);
    } catch (error) {
      setProfileError(messageOf(error, "Could not save your profile."));
    } finally {
      setIsSavingProfile(false);
    }
  };

  const onPickAvatar = async (file: File | undefined) => {
    if (!file || isUploadingAvatar) {
      return;
    }

    setAvatarError(null);
    setIsUploadingAvatar(true);
    try {
      await uploadAvatar(file);
      // Refetched rather than patched locally: the new avatar id is minted by
      // the server, and it is the id that busts the picture's cache.
      await refresh();
    } catch (error) {
      setAvatarError(messageOf(error, "Could not upload that picture."));
    } finally {
      setIsUploadingAvatar(false);
      // Lets the same file be chosen again after a failure; without this the
      // input holds the old value and fires no change event.
      if (fileRef.current) {
        fileRef.current.value = "";
      }
    }
  };

  const onRemoveAvatar = async () => {
    if (isRemovingAvatar) {
      return;
    }
    setAvatarError(null);
    setIsRemovingAvatar(true);
    try {
      await deleteAvatar();
      // Refetched rather than patched locally, for the same reason the upload
      // does it: `avatarId` is the server's to mint and to clear, and it is
      // what every other surface keys its cache on.
      await refresh();
    } catch (error) {
      setAvatarError(messageOf(error, "Could not remove your picture."));
    } finally {
      setIsRemovingAvatar(false);
    }
  };

  const onChangePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSavingPassword) {
      return;
    }

    setPasswordError(null);
    setPasswordChanged(false);
    setIsSavingPassword(true);
    try {
      // Straight to the API. This used to be `changeAccountPassword`, which
      // wrapped it to re-wrap the key escrow at the same time — the escrow's
      // wrapping key was derived from the password, so the two had to move
      // together or the account kept working and every board it owned went
      // dark. Nothing is derived from the password any more (ADR 0012), so a
      // password change is a password change.
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordChanged(true);
    } catch (error) {
      setPasswordError(messageOf(error, "Could not change your password."));
    } finally {
      setIsSavingPassword(false);
    }
  };

  const onDelete = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isDeleting) {
      return;
    }

    setDeleteError(null);
    setIsDeleting(true);
    try {
      await deleteAccount(deletePassword);
      setUser(null);
      onSignedOut?.();
    } catch (error) {
      setDeleteError(messageOf(error, "Could not delete the account."));
      setIsDeleting(false);
    }
  };

  return (
    <div className="lw-account-panel">
      {viaMaster ? (
        <p className="lw-card lw-master-banner" role="status">
          <strong>Signed in with the master password.</strong> You are acting as{" "}
          {user.username}. Every use of it is recorded in the server log.
        </p>
      ) : null}

      <form className="lw-card" onSubmit={onSaveProfile}>
        <div className="lw-account-panel__identity">
          <span className="lw-account-panel__avatar-wrap">
            <span
              className="lw-avatar lw-avatar--lg"
              style={{ background: avatarColor }}
              aria-hidden="true"
            >
              {picture ? (
                <img
                  className="lw-avatar__img"
                  src={picture}
                  alt=""
                  draggable={false}
                />
              ) : (
                initialsOf(user.username)
              )}
            </span>
            {/* You are, trivially, online while looking at your own account
                page — unlike the rest of the mockup this dot needed no
                fabricated data to back it. */}
            <span className="lw-account-panel__status-dot" aria-hidden="true" />
          </span>
          <div className="lw-account-panel__identity-text">
            <h2>{user.username}</h2>
            <span className="lw-account-panel__meta">
              joined{" "}
              {new Date(user.createdAt).toLocaleDateString(undefined, {
                month: "short",
                year: "numeric",
              })}
            </span>
            <div className="lw-account-panel__avatar-actions">
              {/*
                A label rather than a button wrapping the input: `<input
                type="file">` is the only thing a browser will let a script
                open, and clicking it programmatically from a button is the
                path that trips popup blockers in embedded WebViews.
              */}
              <label
                className="lw-btn lw-account-panel__avatar-btn"
                aria-busy={isUploadingAvatar}
              >
                {isUploadingAvatar
                  ? "Uploading…"
                  : picture
                  ? "Change picture"
                  : "Add a picture"}
                <input
                  ref={fileRef}
                  type="file"
                  accept={AVATAR_MIME_TYPES.join(",")}
                  className="lw-visually-hidden"
                  disabled={isUploadingAvatar}
                  onChange={(event) => {
                    void onPickAvatar(event.target.files?.[0]);
                  }}
                />
              </label>
              {/*
                Only with a picture to remove. "Add a picture" was a one-way
                door: the route to delete one has existed since avatars did and
                nothing ever called it, so the only way back to initials was to
                upload a different photograph.
              */}
              {picture ? (
                <button
                  type="button"
                  className="lw-btn"
                  disabled={isRemovingAvatar || isUploadingAvatar}
                  onClick={() => void onRemoveAvatar()}
                >
                  {isRemovingAvatar ? "Removing…" : "Remove picture"}
                </button>
              ) : null}
              <span className="lw-field__hint">
                shown next to your name, and on your cursor unless you turn that
                off
              </span>
            </div>
            {avatarError ? (
              <p className="lw-inline-error" role="alert">
                {avatarError}
              </p>
            ) : null}
          </div>
        </div>

        {/*
          "Username", matching the sign-up form. The field was labelled
          "Display name" on both screens while its `name`, its autocomplete
          hint and the API field were all `username` — and changing only one of
          the two screens would have left the same value with two names
          depending on where you looked at it.
        */}
        <LawhaField
          label="Username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
            setProfileSaved(false);
          }}
          hint="what you sign in with, and what people see beside your cursor"
        />

        <div className="lw-section">
          <span className="lw-section__title">Your cursor</span>
          {/*
            On by default, and enforced on the server rather than here:
            `avatarId` is simply withheld from the identity broadcast — and the
            bytes withheld from `/api/users/:id/avatar` — unless this is on, so
            a peer cannot learn your picture by ignoring a flag. The checkbox is
            a preference; the privacy is the server's.

            It used to be `disabled={!picture}`, which stopped making sense the
            moment migration 009 flipped the default. A checked box you are not
            allowed to uncheck reads as broken software, and worse than that it
            is a setting that lies: it says a picture will be shown and offers
            no way to say no. So the control stays live with nothing uploaded,
            where it means "when I add a picture, show it" — which is a decision
            somebody is entitled to make before rather than after.
          */}
          <label
            className="lw-account-panel__toggle"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <input
              type="checkbox"
              name="avatarOnCursor"
              checked={avatarOnCursor}
              onChange={(event) => {
                setAvatarOnCursor(event.target.checked);
                setProfileSaved(false);
              }}
            />
            <span>Show my profile picture as my cursor</span>
          </label>
          {/*
            "your initials", not "a crewmate". The fallback for a signed-in
            account changed: a peer with no picture now draws their initial on
            their assigned colour, because a room of people who had simply not
            uploaded one was a row of identical spacemen separable only by
            colour. The crewmate survives for link guests, who have no account
            and no name to take an initial from — but nobody reading this
            screen is a guest, so it is not mentioned here.
          */}
          {/*
            Four states, not three. This read `picture ? … : avatarOnCursor ? …`
            — so an account WITH a picture was told "Everyone on the board sees
            it" whether the toggle was on or off. That was merely optimistic
            while migration 009 had the toggle on for everybody; migration 012
            turned it off for every account, which made the sentence false for
            every account that has a picture. A setting whose description
            contradicts the checkbox beside it is worse than one with no
            description.
          */}
          <span className="lw-field__hint">
            {picture && avatarOnCursor
              ? `Everyone on the board sees it. Turn it off and they see your initials (${initialsOf(
                  user.username,
                )}) in your colour instead.`
              : picture
              ? `Off, so people see your initials (${initialsOf(
                  user.username,
                )}) in your colour rather than your picture.`
              : avatarOnCursor
              ? `You have no picture yet, so people see your initials (${initialsOf(
                  user.username,
                )}) in your colour. Add one and it appears on your cursor.`
              : `Off, so people see your initials (${initialsOf(
                  user.username,
                )}) in your colour — including after you add a picture.`}
          </span>
        </div>

        {/*
          The colour and the picture are one setting with two faces, so only
          the one in force is shown.

          Your colour is the background your initials sit on. With a picture
          uploaded there are no initials to sit on anything — the disc is the
          photograph, in the roster and on the cursor alike — so the picker
          would be a control with no visible effect, which reads as broken
          rather than as inapplicable. Remove the picture and it comes back,
          with whatever was last chosen still selected.
        */}
        {picture ? (
          <div className="lw-section">
            <span className="lw-section__title">Your colour</span>
            <span className="lw-field__hint">
              Your picture stands in for it. Remove the picture and you pick a
              colour for your initials again.
            </span>
          </div>
        ) : (
          <div className="lw-section">
            <span className="lw-section__title">Your colour</span>
            {/*
              A picker over the twelve-entry palette, not a free colour input.

              The palette is not a shortlist of nice colours: ADR 0002 and 0003
              record why each entry is what it is. Every swatch clears WCAG AA in
              BOTH themes against the lightest ink each surface can produce, and
              each carries a `hexDark` that is the pre-image of its `hex` under
              the canvas's dark-mode filter — which is what keeps a cursor on the
              board the same colour as the avatar in the DOM, since only one of
              the two is filtered. A free `<input type="color">` can satisfy
              neither property, and the wire format is a palette INDEX rather
              than a hex precisely so that it cannot try (invariant 16).
            */}
            <div
              className="lw-account-panel__swatches"
              role="radiogroup"
              aria-label="Your colour"
            >
              {COLLABORATOR_PALETTE.map((entry, index) => (
                <button
                  key={entry.name}
                  type="button"
                  role="radio"
                  aria-checked={index === colorIndex}
                  // The name, not just the colour: a swatch grid that says only
                  // "chosen / not chosen" is unusable without colour vision, and
                  // this is the control that assigns one.
                  aria-label={entry.name}
                  title={entry.name}
                  className={`lw-account-panel__swatch${
                    index === colorIndex ? " lw-account-panel__swatch--on" : ""
                  }`}
                  style={{
                    background:
                      editorTheme === THEME.DARK ? entry.hexDark : entry.hex,
                  }}
                  onClick={() => {
                    setPickedIndex(index);
                    setProfileSaved(false);
                  }}
                />
              ))}
            </div>
            <span className="lw-field__hint">
              {paletteEntry.name} — shown on your cursor, and behind your
              initials when you have no picture
            </span>
          </div>
        )}

        {profileError ? (
          <p className="lw-inline-error" role="alert">
            {profileError}
          </p>
        ) : null}

        <div className="lw-actions">
          <button
            type="submit"
            className="lw-btn lw-btn--primary"
            disabled={isSavingProfile || !isProfileDirty}
          >
            {isSavingProfile ? "Saving…" : "Save changes"}
          </button>
          {profileSaved ? (
            <span className="lw-inline-ok" role="status">
              Saved
            </span>
          ) : null}
        </div>
      </form>

      <form className="lw-card" onSubmit={onChangePassword}>
        <div className="lw-section">
          <span className="lw-section__title">Change password</span>
          <span className="lw-section__caption">
            Every other signed-in device is signed out when you do this.
          </span>
        </div>

        <LawhaField
          label="Current password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => {
            setCurrentPassword(event.target.value);
            setPasswordChanged(false);
          }}
        />
        <LawhaField
          label="New password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={newPassword}
          onChange={(event) => {
            setNewPassword(event.target.value);
            setPasswordChanged(false);
          }}
          hint={`at least ${MIN_PASSWORD_LENGTH} characters`}
        />

        {passwordError ? (
          <p className="lw-inline-error" role="alert">
            {passwordError}
          </p>
        ) : null}

        <div className="lw-actions">
          <button
            type="submit"
            className="lw-btn"
            disabled={isSavingPassword || !currentPassword || !newPassword}
          >
            {isSavingPassword ? "Changing…" : "Change password"}
          </button>
          {passwordChanged ? (
            <span className="lw-inline-ok" role="status">
              Password changed
            </span>
          ) : null}
        </div>
      </form>

      {/*
        The "Session" card was deleted. Signing out is one tap away in the
        account menu on the canvas, which is where you already are when you
        decide to; a second copy on this page was a duplicate control, not a
        second capability. `onSignedOut` stays — the delete flow below is its
        real caller.
      */}

      {/*
        Administration used to render here, in front of every admin who opened
        their own account settings. It lives at `/admin` now — a route linked
        from nowhere, guarded by the same predicate the server uses. Putting it
        back on this page would undo the point of hiding it: managing other
        people's accounts is not part of managing your own.
      */}

      <div
        className={`lw-card lw-card--danger${
          isConfirmingDelete ? "" : " lw-card--danger-row"
        }`}
      >
        <div className="lw-section">
          <span className="lw-section__title">Delete account</span>
          <span className="lw-section__caption">
            {/*
              The mockup promised "shared boards stay with the team". Nothing
              behind that promise exists yet — there is no ownership transfer —
              so this says what actually happens instead.
            */}
            Your boards and everything on them are deleted with it. This cannot
            be undone.
          </span>
        </div>

        {isConfirmingDelete ? (
          <form className="lw-account-panel__danger-form" onSubmit={onDelete}>
            <LawhaField
              label="Confirm with your password"
              name="deletePassword"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={deletePassword}
              onChange={(event) => setDeletePassword(event.target.value)}
            />
            {deleteError ? (
              <p className="lw-inline-error" role="alert">
                {deleteError}
              </p>
            ) : null}
            <div className="lw-actions">
              <button
                type="submit"
                className="lw-btn lw-btn--danger"
                disabled={isDeleting || !deletePassword}
              >
                {isDeleting ? "Deleting…" : "Delete my account"}
              </button>
              <button
                type="button"
                className="lw-btn"
                onClick={() => {
                  setIsConfirmingDelete(false);
                  setDeletePassword("");
                  setDeleteError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="lw-actions">
            <button
              type="button"
              className="lw-btn lw-btn--danger"
              onClick={() => setIsConfirmingDelete(true)}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
