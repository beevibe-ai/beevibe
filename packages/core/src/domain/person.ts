export interface Person {
  id: string;
  name: string;
  email?: string;
  api_key?: string;
  /**
   * Set when the person finishes (or skips past) the welcome wizard. The
   * web's `/welcome` route redirects to `/` if this is set; chat flips it
   * on the first completed turn so the wizard can't trap a user.
   */
  onboarding_completed_at?: Date;
  created_at: Date;
  updated_at: Date;
}
