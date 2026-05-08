/**
 * A daemon is the long-running process on a user's machine that
 * registers, claims pending sessions, spawns the CLI, and streams
 * events back. One row per (user, machine).
 *
 * `external_id` is daemon-chosen and persisted in `~/.beevibe/config.json`
 * so it survives restarts. `token_hash` is an argon2 hash of the bv_d_<id>
 * token shown to the user once at register-time and stored only on disk
 * on their machine. `last_seen_at` tracks the most recent successful
 * authenticated request (heartbeat or claim).
 */

export interface Daemon {
  id: string;
  owner_person_id: string;
  external_id: string;
  device_name: string;
  token_hash: string;
  last_seen_at?: Date;
  created_at: Date;
  revoked_at?: Date;
}

export type NewDaemon = Omit<Daemon, "created_at" | "last_seen_at" | "revoked_at"> & {
  created_at?: Date;
};
