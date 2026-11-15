/**
 * When the sidebar's files cwd should follow the selected session instead of
 * keeping the user's own picker choice.
 *
 * A selected session's cwd is the chat's worktree: every switch to a session
 * moves the files view there, even when that path was the last one the prop
 * named (a manual picker move in between must not survive a session switch).
 * With the session unchanged, only a new prop value syncs, so a manual picker
 * move is not snapped back.
 */
export interface SidebarCwdFollowState {
  /** The selected session's cwd (or a fresh composer's), from the shell. */
  propCwd: string | null;
  /** The selected session; null for a fresh composer. */
  sessionId: string | null;
  /** The prop value last applied to the files cwd. */
  lastPropCwd: string | null;
  /** The session last applied to the files cwd. */
  lastSessionId: string | null;
}

export function shouldFollowSessionCwd(state: SidebarCwdFollowState): boolean {
  if (!state.propCwd) return false;
  if (state.propCwd !== state.lastPropCwd) return true;
  return (state.sessionId ?? null) !== state.lastSessionId;
}
