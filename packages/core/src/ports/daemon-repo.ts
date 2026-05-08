import type { Daemon, NewDaemon } from "../domain/daemon.js";

export type DaemonPatch = Partial<
  Pick<Daemon, "device_name" | "token_hash" | "last_seen_at" | "revoked_at">
>;

export interface DaemonRepository {
  findById(id: string): Promise<Daemon | undefined>;

  /**
   * Used by `/runtime/register` to upsert by the daemon-chosen `external_id`.
   * The (owner_person_id, external_id) tuple is unique; re-registering from
   * the same machine returns the existing row instead of creating a duplicate.
   */
  findByOwnerAndExternalId(
    ownerPersonId: string,
    externalId: string,
  ): Promise<Daemon | undefined>;

  /** Resolve a daemon by its bv_d_<id> token hash. */
  findByTokenHash(tokenHash: string): Promise<Daemon | undefined>;

  /** Active daemons (revoked_at IS NULL) for a person — used by the Runtimes panel. */
  listActiveByOwner(ownerPersonId: string): Promise<Daemon[]>;

  create(input: NewDaemon): Promise<Daemon>;

  update(id: string, patch: DaemonPatch): Promise<Daemon>;

  /** Stamp `last_seen_at = now()` when the daemon authenticates. */
  touchLastSeen(id: string): Promise<void>;

  /** Soft-delete: sets `revoked_at = now()`. ON DELETE CASCADE in the schema
   *  takes care of the daemon's runtimes. */
  revoke(id: string): Promise<void>;
}
