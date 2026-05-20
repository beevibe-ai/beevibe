export interface Person {
  id: string;
  name: string;
  email?: string;
  api_key?: string;
  /**
   * scrypt password hash (self-describing format with embedded params +
   * salt). NULL for legacy / seed users; their sign-in falls back to the
   * `bv_u_` paste path. Set on signup or via "set password" on first
   * password sign-in attempt.
   */
  password_hash?: string;
  /**
   * Set on the first successful chat turn. NULL = welcome-wizard not
   * yet completed; the chat handler injects ONBOARDING_DIRECTIVES into
   * the system prompt until this is stamped.
   */
  onboarding_completed_at?: Date;
  /**
   * Per-user toggle for the capability network surface (Try-a-repo,
   * /capabilities, find_repo + use_repo MCP tools). Default TRUE;
   * flip OFF in /settings to hide the UI and strip the MCP tools.
   */
  capability_network_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}
