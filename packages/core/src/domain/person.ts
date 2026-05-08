export interface Person {
  id: string;
  name: string;
  email?: string;
  api_key?: string;
  /**
   * Set on the first successful chat turn. NULL = welcome-wizard not
   * yet completed; the chat handler injects ONBOARDING_DIRECTIVES into
   * the system prompt until this is stamped.
   */
  onboarding_completed_at?: Date;
  created_at: Date;
  updated_at: Date;
}
