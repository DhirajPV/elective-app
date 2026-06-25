/**
 * A Creator is a person waiting to be onboarded onto the platform.
 *
 * This is intentionally its own entity (rather than the list tracking a bare
 * count) so the model can grow: today it carries identity + a join timestamp,
 * tomorrow it can carry a tier, social handles, payout details, etc. without
 * touching the cohort/queue logic.
 */

import { randomUUID } from "crypto";

export interface Creator {
  /** Stable unique id, assigned when the creator joins the list. */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Platform handle, e.g. "@ada". */
  readonly handle: string;
  /** ISO-8601 timestamp of when the creator joined the waiting list. */
  readonly joinedAt: string;
}

export interface CreatorInput {
  name?: string;
  handle?: string;
}

/**
 * Build a Creator, filling in an id, a join timestamp, and friendly
 * placeholder name/handle when they aren't supplied.
 *
 * The placeholder lets the count-only API ("add 13 creators") keep working
 * while still producing real, addressable creator records.
 */
export function createCreator(input: CreatorInput = {}): Creator {
  const id = randomUUID();
  const short = id.slice(0, 4);
  const name = input.name?.trim() || `Creator ${short}`;
  const handle = normalizeHandle(input.handle) || `@creator_${short}`;
  return { id, name, handle, joinedAt: new Date().toISOString() };
}

function normalizeHandle(handle?: string): string | undefined {
  const trimmed = handle?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}
