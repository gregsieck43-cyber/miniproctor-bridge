// Zero-message native lifecycle verification: Windows Droid 0.230.0 only.
// This overlay must be supplied through --settings BEFORE initialize_session.
// It is not a complete Droid sandbox or a capability/identity verification.
export const FACTORY_HOOK_CONTROL_IDENTITY = Object.freeze({
  version: '0.230.0',
  sha256: 'fba64d3a907e039bc34301b74bdfc61870b2ca7659a6ccb0978174dfe26e81c3',
});

function reject(message) {
  const error = new Error(message);
  error.code = 'FACTORY_HOOK_CONTROL_UNVERIFIED';
  throw error;
}

function ownData(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && Object.hasOwn(property, 'value') ? property.value : undefined;
}

function assertNativeIdentity(identity) {
  if (ownData(identity, 'version') !== FACTORY_HOOK_CONTROL_IDENTITY.version
      || ownData(identity, 'sha256') !== FACTORY_HOOK_CONTROL_IDENTITY.sha256) {
    reject('Factory hook suppression has not been verified for this native identity');
  }
}

/**
 * Native HookSettings owns hooksDisabled. A top-level hooksDisabled becomes a
 * general setting and did NOT suppress either user or project lifecycle hooks.
 * Keep this separate from other settings so untrusted settings cannot override
 * the true value while constructing the final runtime overlay.
 */
export function createFactoryHookSuppressionOverlay(nativeIdentity) {
  assertNativeIdentity(nativeIdentity);
  return Object.freeze({ hooks: Object.freeze({ hooksDisabled: true }) });
}

/** Validate the final serialized --settings input, not an earlier merge input. */
export function assertFactoryHookSuppressionOverlay(settings, nativeIdentity) {
  assertNativeIdentity(nativeIdentity);
  if (ownData(ownData(settings, 'hooks'), 'hooksDisabled') !== true) {
    reject('Factory runtime settings must contain hooks.hooksDisabled === true');
  }
  return true;
}
