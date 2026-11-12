// =====================================================================================
// Org profile change log
//
// An org's admin can change its name, address and map pin (Settings -> Update
// Organization; the org update rule lets an admin change only those four fields), and a
// verified org keeps its "Verified" badge on everyone's map afterwards. Nothing else
// re-checks or records such changes:
//
//   recordOrgProfileChange  runs on every update of organizations/{orgId}. When name,
//                           address, latitude or longitude changed, it writes one
//                           org_profile_changes doc: old and new values, who made the
//                           change, when, and needsReview for the owner to re-check it.
//                           Updates that touch none of those fields (status, subscription
//                           and so on) are skipped without a single read or write.
//
// Not flagged for review: changes made by a super admin, and changes to a pending org
// (already in the owner's Admin Review queue) or a rejected one (locked).
// scripts/org-profile-changes.js lists the changes and marks them reviewed. Clients can't
// read or write org_profile_changes: firestore.rules has no match for it.
//
// The record id comes from the org doc's update time, so a redelivered event finds its
// record already there and adds nothing. Nothing here writes to organizations, so the
// trigger can't fire itself.
//
// No firebase imports here: db, FieldValue and logger are injected so the handler can
// run against an in-memory Firestore in tests.
// =====================================================================================

const COLLECTION = 'org_profile_changes';

// The fields an org admin can change, in the order records list them.
const TRACKED_FIELDS = ['name', 'address', 'latitude', 'longitude'];

// Changes to orgs in these statuses aren't flagged: pending orgs are already in the
// Admin Review queue, and rejected orgs are locked.
const UNFLAGGED_STATUSES = ['pending', 'rejected'];

// Same radius as the app's haversineDistanceMiles (src/utils/geo.ts).
const EARTH_RADIUS_MILES = 3958.8;

// gRPC status ALREADY_EXISTS: how DocumentReference.create() fails when the doc is
// already there.
const ALREADY_EXISTS = 6;

// Firestore's limit on a document id.
const MAX_DOC_ID_BYTES = 1500;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// null and a missing field both mean "no value".
function isAbsent(value) {
  return value === undefined || value === null;
}

// Equality of two Firestore field values: absent equals absent, numbers by value (NaN
// equals NaN), strings exactly, Timestamps, GeoPoints and the like through isEqual, and
// anything else (maps, arrays, booleans) by its JSON. Values of different types are never
// equal, and isEqual only ever sees its own type: the SDK's VectorValue.isEqual throws
// when given anything else.
function valuesEqual(a, b) {
  if (isAbsent(a) || isAbsent(b)) return isAbsent(a) && isAbsent(b);
  if (typeof a === 'number' || typeof b === 'number') {
    return typeof a === 'number' && typeof b === 'number' &&
      (a === b || (Number.isNaN(a) && Number.isNaN(b)));
  }
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (typeof a.isEqual === 'function') return a.isEqual(b) === true;
  return JSON.stringify(a) === JSON.stringify(b);
}

// The tracked fields whose value differs between two versions of an org doc.
function changedTrackedFields(before, after) {
  return TRACKED_FIELDS.filter(field => !valuesEqual(before[field], after[field]));
}

// { name, address, latitude, longitude } of an org doc, null where absent.
function trackedValues(data) {
  return Object.fromEntries(TRACKED_FIELDS.map(field => [field, data[field] ?? null]));
}

// Firestore's document id rules: a string of 1 to 1500 UTF-8 bytes, without '/', other
// than '.' and '..', and not of the reserved form __...__.
function isUsableDocId(id) {
  return typeof id === 'string' &&
    id.length > 0 &&
    Buffer.byteLength(id, 'utf8') <= MAX_DOC_ID_BYTES &&
    !id.includes('/') &&
    id !== '.' &&
    id !== '..' &&
    !/^__.*__$/.test(id);
}

// A profile's org, read like profileOrgId in index.js: organization_id when present,
// otherwise the legacy organizationId. null unless a non-empty string other than
// 'removed' (what removing a member leaves on their profile).
function actorOrgId(profile) {
  const orgId = 'organization_id' in profile ? profile.organization_id : profile.organizationId;
  return isNonEmptyString(orgId) && orgId !== 'removed' ? orgId : null;
}

function needsReviewFor(actorRole, orgStatus) {
  return actorRole !== 'super_admin' && !UNFLAGGED_STATUSES.includes(orgStatus);
}

// Same formula as the app's haversineDistanceMiles (src/utils/geo.ts), except that `a`
// is capped at 1: rounding pushes it just over 1 for some antipodal points, which would
// make the distance NaN.
function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRadians = degrees => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.min(1, Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2));
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function hasValidPin(data) {
  const { latitude, longitude } = data;
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

// How far the map pin moved, in miles rounded to 2 decimals. null when the pin didn't
// change, or when either version has no valid pin.
function pinMovedMiles(before, after) {
  const moved = !valuesEqual(before.latitude, after.latitude) ||
    !valuesEqual(before.longitude, after.longitude);
  if (!moved || !hasValidPin(before) || !hasValidPin(after)) return null;
  const miles = haversineMiles(before.latitude, before.longitude, after.latitude, after.longitude);
  return Math.round(miles * 100) / 100;
}

function isTimestamp(value) {
  return !!value && Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds);
}

// One id per version of the org doc, so every delivery of an event maps to the same
// record. null (use an auto id) without an update time.
function recordIdFor(orgDocId, updateTime) {
  if (!isTimestamp(updateTime)) return null;
  const id = `${orgDocId}_${updateTime.seconds}_${updateTime.nanoseconds}`;
  return isUsableDocId(id) ? id : null;
}

// Who made the change. authId is expected to be the uid of the signed-in app user, but
// Google doesn't document what it holds, so it's only used to look up a profile; any
// other value leaves the actor unresolved.
async function resolveActor(db, authId) {
  const unresolved = { uid: null, role: null, name: null, email: null, orgId: null };
  if (!isUsableDocId(authId)) return unresolved;
  const profileSnap = await db.collection('users').doc(authId).get();
  if (!profileSnap.exists) return unresolved;
  const profile = profileSnap.data() || {};
  const stringOrNull = value => (typeof value === 'string' ? value : null);
  return {
    uid: authId,
    role: stringOrNull(profile.role),
    name: stringOrNull(profile.name),
    email: stringOrNull(profile.email),
    orgId: actorOrgId(profile),
  };
}

// Creates the doc; false if it already exists.
async function createIfAbsent(ref, data) {
  try {
    await ref.create(data);
    return true;
  } catch (error) {
    if (error && error.code === ALREADY_EXISTS) return false;
    throw error;
  }
}

function isSnapshot(value) {
  return !!value && typeof value.data === 'function';
}

// Builds the onDocumentUpdatedWithAuthContext('organizations/{orgId}') handler. Resolves
// to an outcome object (used by tests; Cloud Functions ignores it). Throws only on
// unexpected errors, so the event is redelivered.
function createRecordOrgProfileChangeHandler({ db, FieldValue, logger = console }) {
  return async (event) => {
    const change = event && event.data;
    const beforeSnap = change && change.before;
    const afterSnap = change && change.after;
    const orgDocId = (event && event.params && event.params.orgId) || (afterSnap && afterSnap.id);
    if (!isSnapshot(beforeSnap) || !isSnapshot(afterSnap) || !isNonEmptyString(orgDocId)) {
      logger.warn('[recordOrgProfileChange] event has no document data, skipping');
      return { outcome: 'skipped', reason: 'no_data' };
    }

    const before = beforeSnap.data() || {};
    const after = afterSnap.data() || {};
    const changedFields = changedTrackedFields(before, after);
    if (changedFields.length === 0) {
      return { outcome: 'skipped', reason: 'no_tracked_change' };
    }

    const authType = event.authType ?? null;
    const authId = event.authId ?? null;
    const updateTime = isTimestamp(afterSnap.updateTime) ? afterSnap.updateTime : null;
    const recordId = recordIdFor(orgDocId, updateTime);
    const ref = recordId ? db.collection(COLLECTION).doc(recordId) : db.collection(COLLECTION).doc();

    let actor;
    let needsReview;
    let created;
    try {
      actor = await resolveActor(db, authId);
      needsReview = needsReviewFor(actor.role, after.status);
      // Every value is set, null when unknown: Firestore rejects undefined.
      created = await createIfAbsent(ref, {
        orgDocId,
        orgIdField: isNonEmptyString(after.id) ? after.id : null,
        orgName: after.name ?? null,
        orgStatus: after.status ?? null,
        changedFields,
        before: trackedValues(before),
        after: trackedValues(after),
        pinMovedMiles: pinMovedMiles(before, after),
        changedBy: { authType, authId, ...actor },
        changedAt: updateTime,
        eventId: event.id ?? null,
        eventTime: event.time ?? null,
        recordedAt: FieldValue.serverTimestamp(),
        needsReview,
        reviewedAt: null,
        reviewedBy: null,
        reviewNote: null,
      });
    } catch (error) {
      logger.error(`[recordOrgProfileChange] failed for org ${orgDocId}:`, error);
      throw error;
    }
    if (!created) {
      // A redelivered event: its record is already there.
      return { outcome: 'duplicate', id: ref.id };
    }

    // Ids only: no names, emails, addresses or values in the logs.
    const by = actor.uid ?? authType ?? 'unknown';
    const line = `[recordOrgProfileChange] ${needsReview ? 'needs review' : 'recorded'}: ` +
      `org ${orgDocId} fields ${changedFields.join(',')} by ${by} (${ref.id})`;
    if (needsReview) {
      logger.warn(line);
    } else {
      logger.log(line);
    }
    return { outcome: 'recorded', id: ref.id, needsReview };
  };
}

module.exports = {
  COLLECTION,
  TRACKED_FIELDS,
  valuesEqual,
  changedTrackedFields,
  trackedValues,
  isUsableDocId,
  actorOrgId,
  needsReviewFor,
  haversineMiles,
  pinMovedMiles,
  recordIdFor,
  createRecordOrgProfileChangeHandler,
};
