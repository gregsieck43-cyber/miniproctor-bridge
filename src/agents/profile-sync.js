/** Bridge -> syncReport: only the public profile digest leaves this machine. */
import { CAPABILITY_KEYS } from '../adapters/capabilities.js';
import { getProductRuntime } from './product-runtime.js';

export const MAX_PROFILES_PER_SYNC = 50;

export function buildProfileProjection(profile) {
  const active = profile.status === 'active' && profile.deleted_at == null;
  const health = !active || ['degraded', 'unreachable'].includes(profile.health?.status)
    ? 'unavailable'
    : profile.health?.status === 'ok' ? 'ok' : 'unknown';
  const runtime = getProductRuntime(profile.agent_key);
  const canOpen = active && health === 'ok' && runtime !== null;
  const capabilities = {};
  for (const key of CAPABILITY_KEYS) capabilities[key] = canOpen && runtime.open[key] === true;
  capabilities.integrationMode = canOpen ? runtime.open.integrationMode : null;
  capabilities.initialPromptChannel = canOpen ? runtime.open.initialPromptChannel : null;
  const lastChecked = Number(profile.health?.last_checked_at);
  const deletedAt = Number(profile.deleted_at);
  return {
    profile_id: profile.profile_id,
    revision: profile.revision,
    agent_key: profile.agent_key,
    display_name: profile.display_name,
    ...(profile.adapter_version ? { cli_version: profile.adapter_version } : {}),
    capabilities,
    health,
    ...(Number.isFinite(lastChecked) && lastChecked > 0 ? { last_seen: lastChecked } : {}),
    ...(profile.deleted_at != null && Number.isFinite(deletedAt) && deletedAt > 0 ? { deleted_at: deletedAt } : {}),
  };
}

export async function syncProfileProjections({ profileStore, transport }) {
  if (typeof transport.pushProfiles !== 'function') {
    throw new Error('profile-sync-transport-unsupported');
  }
  const profiles = profileStore.list({ includeDisabled: true, includeDeleted: true });
  let synced = 0;
  for (let i = 0; i < profiles.length; i += MAX_PROFILES_PER_SYNC) {
    const batch = profiles.slice(i, i + MAX_PROFILES_PER_SYNC).map(buildProfileProjection);
    const result = await transport.pushProfiles(batch);
    const projection = result?.data?.profile_projection;
    if (result?.ok !== true || !projection || projection.revoked === true) {
      throw new Error('profile-sync-invalid-response');
    }
    if (projection.rejected?.length) {
      throw new Error('profile-projection-rejected');
    }
    synced += batch.length;
  }
  return { synced };
}

export class ProfileSyncService {
  constructor({ profileStore, transport, intervalMs = 30_000, logger = console }) {
    this.profileStore = profileStore;
    this.transport = transport;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
    this.inflight = null;
  }

  syncNow() {
    if (this.inflight) return this.inflight;
    const task = syncProfileProjections({ profileStore: this.profileStore, transport: this.transport });
    this.inflight = task;
    void task.finally(() => { if (this.inflight === task) this.inflight = null; }).catch(() => {});
    return task;
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.syncNow().catch((err) => {
          this.logger.warn?.('[profiles] sync failed; next interval will retry', { code: err?.code || err?.message || 'unknown' });
        });
      }, this.intervalMs);
    }
    return this.syncNow();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
