// =====================================================================================
// Invite join repair
//
// Live app builds (v1.2.7) create users/{uid} right after validateInviteCode succeeds,
// but from stale sign-up state: role '' and organization_id ''. The new member ends up
// in no org and lands on "SUBSCRIPTION EXPIRED". Without a client update, the server
// fills the org in:
//
//   validateInviteCode  records an invite_join_intents doc for every successful validation.
//   repairInviteJoin    runs when a users/{uid} doc is created, and acts only on the exact
//                       profile the live sign-up writes (isInviteSignupProfile). It looks at
//                       every intent validated in the 5 minutes before the doc was created.
//                       All of them for one org and one role -> attach the user to it and
//                       consume the oldest unconsumed intent. Several orgs or roles, or
//                       nothing left to consume -> attach nothing and flag
//                       invite_join_review/{uid}. Any other doc is left alone.
//
// Consumed intents still count when comparing orgs and roles. A joiner's own intent (once
// recorded) sits in their window, so they can only ever get that intent's org and role,
// even if someone else's doc consumed it first.
//
// No firebase imports here: db, FieldValue, Timestamp and logger are injected so the
// handler can run against an in-memory Firestore in tests.
// =====================================================================================

const INTENTS_COLLECTION = 'invite_join_intents';
const REVIEW_COLLECTION = 'invite_join_review';

// Reason stamped on invite_join_review when a profile self-asserted membership in an
// organization that already has other members (a cross-org takeover attempt).
const QUARANTINE_REASON = 'unauthorized_org_claim';

// An intent matches if validated within [createTime - 5 min, createTime]. The client
// creates the profile a few seconds after validating, with no user input in between; the
// rest of the 5 minutes is room for a slow network. validateInviteCode commits the intent
// before it responds, so the user's own intent is always older than their doc: anything
// validated later belongs to someone else.
const WINDOW_BEFORE_MS = 5 * 60 * 1000;

// Max intents considered per repair. If a window ever holds more, we can't see every
// candidate, so the user goes to manual review instead of being guessed into an org.
const INTENT_QUERY_LIMIT = 50;

// Roles an invite code can grant (same list generateInviteCode accepts).
const ALLOWED_ROLES = ['member', 'security', 'admin'];

// Every field of the profile the live sign-up writes (sorted); it writes no others.
const SIGNUP_PROFILE_FIELDS = [
  'created_at', 'email', 'email_verified', 'id', 'name', 'organization_id', 'role', 'tos_accepted_at',
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value) {
  return !!value && typeof value.toMillis === 'function';
}

// True if the user doc already names an org (both spellings are used in this codebase).
function hasOrganization(userData) {
  return !!userData &&
    (isNonEmptyString(userData.organization_id) || isNonEmptyString(userData.organizationId));
}

// The org id a user doc names, preferring snake_case (what the live client writes),
// then camelCase; '' when it names none.
function orgIdOf(userData) {
  if (!userData) return '';
  if (isNonEmptyString(userData.organization_id)) return userData.organization_id;
  if (isNonEmptyString(userData.organizationId)) return userData.organizationId;
  return '';
}

// True only for the doc the live sign-up writes on an invite join: exactly its 8 fields,
// with the stale role '' and organization_id ''. Other org-less docs, such as the TOS
// screen's setDoc(merge) fallback ({ tos_accepted_at } only) or a doc made in the console,
// are not invite joins and must never be matched to someone's intent.
function isInviteSignupProfile(userData, uid) {
  if (!userData) return false;
  const fields = Object.keys(userData).sort();
  return fields.length === SIGNUP_PROFILE_FIELDS.length &&
    fields.every((field, i) => field === SIGNUP_PROFILE_FIELDS[i]) &&
    userData.id === uid &&
    userData.role === '' &&
    userData.organization_id === '' &&
    userData.email_verified === false &&
    typeof userData.email === 'string' &&
    typeof userData.name === 'string' &&
    isTimestamp(userData.created_at) &&
    isTimestamp(userData.tos_accepted_at);
}

function sanitizeRole(role) {
  return ALLOWED_ROLES.includes(role) ? role : 'member';
}

// Pure decision for a sign-up profile created at refMillis.
//   candidates: [{ id, organizationId, role, validatedAtMillis, consumed }]
//   options.truncated: the intent query hit its limit, so the window may be incomplete
// Returns { action: 'assign', intentId, organizationId, role }
//      or { action: 'review', reason, candidateOrgIds }, reason being
//         'ambiguous'       several orgs in the window (or too many intents to tell)
//         'ambiguous_role'  one org, but codes granting different roles
//         'no_intent'       nothing unconsumed left to match
function decideJoinRepair(candidates, refMillis, options = {}) {
  const windowStart = refMillis - WINDOW_BEFORE_MS;

  // Consumed or not, every intent in the window counts toward the org and role checks.
  const inWindow = (candidates || []).filter(c =>
    c &&
    isNonEmptyString(c.organizationId) &&
    Number.isFinite(c.validatedAtMillis) &&
    c.validatedAtMillis >= windowStart &&
    c.validatedAtMillis <= refMillis
  );
  const candidateOrgIds = [...new Set(inWindow.map(c => c.organizationId))].sort();
  const review = reason => ({ action: 'review', reason, candidateOrgIds });

  if (options.truncated || candidateOrgIds.length > 1) {
    return review('ambiguous');
  }
  if (new Set(inWindow.map(c => sanitizeRole(c.role))).size > 1) {
    return review('ambiguous_role');
  }
  const open = inWindow.filter(c => c.consumed === false);
  if (open.length === 0) {
    return review('no_intent');
  }

  // Oldest unconsumed intent wins; ties are broken by id so the pick is deterministic.
  const oldest = open.sort((a, b) =>
    (a.validatedAtMillis - b.validatedAtMillis) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )[0];

  return {
    action: 'assign',
    intentId: oldest.id,
    organizationId: oldest.organizationId,
    role: sanitizeRole(oldest.role),
  };
}

function toCandidate(intentDoc) {
  const data = intentDoc.data() || {};
  const validatedAt = data.validatedAt;
  return {
    id: intentDoc.id,
    organizationId: data.organizationId,
    role: data.role,
    validatedAtMillis: isTimestamp(validatedAt) ? validatedAt.toMillis() : NaN,
    consumed: data.consumed,
  };
}

// Reference time: the created doc's createTime, falling back to the event time.
function referenceMillis(event) {
  const createTime = event.data && event.data.createTime;
  if (isTimestamp(createTime)) {
    return createTime.toMillis();
  }
  return event.time ? Date.parse(event.time) : NaN;
}

// Validates a newly created profile that already names an organization. The live client
// writes such a profile only when a user creates their OWN new org (role 'admin',
// org = the org they just made). Because org docs carry no owner field and the live
// client can't be changed, legitimacy is decided by "first member wins": the creator /
// provisioned admin is the sole member of a brand-new org, whereas an attacker who
// self-asserts into an existing org finds that org already has members. In the latter
// case the asserted membership is revoked (role/org cleared) and flagged for review.
// Only members whose profiles predate this one count, so a redelivered event judges
// the org as it was when the profile was created, not after people joined it.
//
// 'super_admin' is never touched: the client rules forbid setting it, so it can only
// come from the admin SDK / console, which is trusted.
async function validateAssertedMembership({ db, FieldValue, Timestamp, logger }, uid, created, event) {
  if (created.role === 'super_admin') {
    return { outcome: 'skipped', reason: 'trusted_role' };
  }
  const claimedOrgId = orgIdOf(created);
  if (!isNonEmptyString(claimedOrgId)) {
    // A role but no org grants no org-scoped access; leave it alone.
    return { outcome: 'skipped', reason: 'no_org_claim' };
  }

  const userRef = db.collection('users').doc(uid);
  const reviewRef = db.collection(REVIEW_COLLECTION).doc(uid);
  const membersQuery = db.collection('users').where('organization_id', '==', claimedOrgId);
  const refMillis = referenceMillis(event);

  let result;
  try {
    result = await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        return { outcome: 'skipped', reason: 'user_missing' };
      }
      const userData = userSnap.data() || {};
      // Cleared or changed since the create event: no longer ours to act on.
      if (!hasOrganization(userData)) {
        return { outcome: 'skipped', reason: 'already_cleared' };
      }
      if (userData.role === 'super_admin') {
        return { outcome: 'skipped', reason: 'trusted_role' };
      }
      if (orgIdOf(userData) !== claimedOrgId) {
        return { outcome: 'skipped', reason: 'org_changed' };
      }

      const membersSnap = await tx.get(membersQuery);
      const hasOtherMember = membersSnap.docs.some(d => d.id !== uid &&
        (!Number.isFinite(refMillis) || d.createTime.toMillis() < refMillis));
      if (!hasOtherMember) {
        // Sole (first) member of the org — a legitimate creator / provisioned admin.
        return { outcome: 'skipped', reason: 'sole_member' };
      }

      // The org already has members, so this account did not create it. Revoke the
      // self-asserted role and membership (both field spellings) and flag it.
      tx.update(userRef, {
        role: '',
        organization_id: '',
        organizationId: '',
        inviteJoinQuarantinedAt: FieldValue.serverTimestamp(),
        inviteJoinClaimedOrgId: claimedOrgId,
      });
      tx.set(reviewRef, {
        uid,
        reason: QUARANTINE_REASON,
        claimedOrgId,
        userCreatedAt: Number.isFinite(refMillis) ? Timestamp.fromMillis(refMillis) : null,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { outcome: 'quarantined', claimedOrgId };
    });
  } catch (error) {
    logger.error(`repairInviteJoin: membership check failed for users/${uid}:`, error);
    throw error;
  }

  if (result.outcome === 'quarantined') {
    logger.warn(`repairInviteJoin: users/${uid} self-asserted membership in org ${result.claimedOrgId}, which already has members; membership revoked and flagged for review`);
  } else {
    logger.log(`repairInviteJoin: users/${uid} membership assertion skipped (${result.reason})`);
  }
  return result;
}

// Builds the onDocumentCreated('users/{uid}') handler. Resolves to an outcome object
// (used by tests; Cloud Functions ignores it). Throws only on unexpected errors.
function createRepairInviteJoinHandler({ db, FieldValue, Timestamp, logger = console }) {
  return async (event) => {
    const snapshot = event && event.data;
    const uid = (event && event.params && event.params.uid) || (snapshot && snapshot.id);
    if (!snapshot || !uid) {
      logger.warn('repairInviteJoin: event has no document data, skipping');
      return { outcome: 'skipped', reason: 'no_data' };
    }

    // A profile that already names an org is either a legitimate org creator (the first
    // member of a brand-new org) or an attacker self-asserting into an existing org.
    const created = snapshot.data();
    if (hasOrganization(created)) {
      return validateAssertedMembership({ db, FieldValue, Timestamp, logger }, uid, created, event);
    }
    // Not the invite sign-up profile: leave the doc and every intent alone.
    if (!isInviteSignupProfile(created, uid)) {
      logger.log(`repairInviteJoin: users/${uid} has no organization but is not an invite sign-up profile, skipped`);
      return { outcome: 'skipped', reason: 'unexpected_shape' };
    }

    const refMillis = referenceMillis(event);
    if (!Number.isFinite(refMillis)) {
      // Not expected: created docs carry createTime and every event carries a time.
      const error = new Error(`repairInviteJoin: no reference time for users/${uid}`);
      logger.error(error.message);
      throw error;
    }

    const userRef = db.collection('users').doc(uid);
    const reviewRef = db.collection(REVIEW_COLLECTION).doc(uid);
    // One repair per account: an intent this uid already consumed means a deleted and
    // re-created profile, which must not be attached to whoever validated last.
    const consumedByUserQuery = db.collection(INTENTS_COLLECTION)
      .where('consumedBy', '==', uid)
      .limit(1);
    // Range + orderBy on validatedAt only, so the automatic single-field index serves it.
    // One extra doc is read to detect a window holding more than INTENT_QUERY_LIMIT.
    const intentsQuery = db.collection(INTENTS_COLLECTION)
      .where('validatedAt', '>=', Timestamp.fromMillis(refMillis - WINDOW_BEFORE_MS))
      .where('validatedAt', '<=', Timestamp.fromMillis(refMillis))
      .orderBy('validatedAt')
      .limit(INTENT_QUERY_LIMIT + 1);

    let result;
    try {
      result = await db.runTransaction(async (tx) => {
        // Re-check inside the transaction: triggers are delivered at least once, and a
        // duplicate delivery (or a manual fix in the meantime) must leave the user alone.
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) {
          return { outcome: 'skipped', reason: 'user_missing' };
        }
        const userData = userSnap.data() || {};
        if (hasOrganization(userData)) {
          return { outcome: 'skipped', reason: 'has_org' };
        }
        // Changed or replaced since it was created: no longer ours to touch.
        if (!isInviteSignupProfile(userData, uid)) {
          return { outcome: 'skipped', reason: 'unexpected_shape' };
        }
        const reviewSnap = await tx.get(reviewRef);
        if (reviewSnap.exists) {
          return { outcome: 'skipped', reason: 'already_flagged' };
        }
        const consumedByUserSnap = await tx.get(consumedByUserQuery);
        if (!consumedByUserSnap.empty) {
          return { outcome: 'skipped', reason: 'already_repaired' };
        }

        const intentsSnap = await tx.get(intentsQuery);
        const decision = decideJoinRepair(intentsSnap.docs.map(toCandidate), refMillis, {
          truncated: intentsSnap.size > INTENT_QUERY_LIMIT,
        });

        if (decision.action === 'assign') {
          // The role always comes from the intent, never from what the user doc says.
          tx.update(userRef, {
            organization_id: decision.organizationId,
            role: decision.role,
            inviteJoinRepairedAt: FieldValue.serverTimestamp(),
            inviteJoinIntentId: decision.intentId,
          });
          tx.update(db.collection(INTENTS_COLLECTION).doc(decision.intentId), {
            consumed: true,
            consumedBy: uid,
            consumedAt: FieldValue.serverTimestamp(),
          });
          return {
            outcome: 'assigned',
            organizationId: decision.organizationId,
            role: decision.role,
            intentId: decision.intentId,
          };
        }

        // No email or name: staff can read users/{uid} while it exists, and nothing
        // personal is left behind here once the account is deleted.
        tx.set(reviewRef, {
          uid,
          reason: decision.reason,
          candidateOrgIds: decision.candidateOrgIds,
          userCreatedAt: Timestamp.fromMillis(refMillis),
          createdAt: FieldValue.serverTimestamp(),
        });
        return { outcome: 'review', reason: decision.reason, candidateOrgIds: decision.candidateOrgIds };
      });
    } catch (error) {
      logger.error(`repairInviteJoin: failed for users/${uid}:`, error);
      throw error;
    }

    // Logged after commit so transaction retries don't repeat log lines.
    if (result.outcome === 'assigned') {
      logger.log(`repairInviteJoin: attached users/${uid} to org ${result.organizationId} as ${result.role} (intent ${result.intentId})`);
    } else if (result.outcome === 'review') {
      logger.warn(`repairInviteJoin: users/${uid} has no organization, flagged for review (${result.reason}; candidate orgs: ${result.candidateOrgIds.join(', ') || 'none'})`);
    } else {
      logger.log(`repairInviteJoin: users/${uid} skipped (${result.reason})`);
    }
    return result;
  };
}

module.exports = {
  INTENTS_COLLECTION,
  REVIEW_COLLECTION,
  QUARANTINE_REASON,
  WINDOW_BEFORE_MS,
  INTENT_QUERY_LIMIT,
  hasOrganization,
  orgIdOf,
  isInviteSignupProfile,
  sanitizeRole,
  decideJoinRepair,
  validateAssertedMembership,
  createRepairInviteJoinHandler,
};
