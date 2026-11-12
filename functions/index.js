const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();

// Get Firestore instance - this will use the (default) database
const db = admin.firestore();

// Helper function to generate random invite code
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed ambiguous chars
  let code = 'JOIN-';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  code += '-';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code; // Format: JOIN-XXXX-XXXX
}

const { INTENTS_COLLECTION, WINDOW_BEFORE_MS } = require('./inviteJoinRepair');

// The org an invite code points at. Codes store the org's `id` field, which for orgs
// created in the app differs from the doc id; some older orgs and their codes use the
// doc id instead. If several docs match, the oldest is the real org: a copy planted
// later can't predate it.
async function findInviteOrgDoc(orgId) {
  const [byIdField, direct] = await Promise.all([
    db.collection('organizations').where('id', '==', orgId).get(),
    db.collection('organizations').doc(orgId).get(),
  ]);
  const candidates = [...byIdField.docs];
  if (direct.exists && !candidates.some(d => d.id === direct.id)) candidates.push(direct);
  if (!candidates.length) return null;
  return candidates.reduce((oldest, d) =>
    (d.createTime.toMillis() < oldest.createTime.toMillis() ? d : oldest));
}

// A profile's org, read the way the security rules read it: organization_id when present,
// otherwise the legacy organizationId. '' when the profile has no usable org.
function profileOrgId(profile) {
  const orgId = 'organization_id' in profile ? profile.organization_id : profile.organizationId;
  return typeof orgId === 'string' && orgId !== 'removed' ? orgId : '';
}

// createdBy values of codes written by the admin scripts rather than by a user.
const SCRIPT_CODE_CREATORS = new Set(['system', 'test-admin', 'e2e-test']);

// A code only works while whoever minted it still administers the code's org, so codes
// from an admin who was demoted, moved, quarantined or deleted stop working.
async function codeCreatorStillAdmin(codeData) {
  const creatorId = codeData.createdBy;
  if (typeof creatorId !== 'string' || !creatorId) return false;
  const creatorDoc = await db.collection('users').doc(creatorId).get();
  if (!creatorDoc.exists) return SCRIPT_CODE_CREATORS.has(creatorId);
  const creator = creatorDoc.data();
  if (creator.role === 'super_admin') return true;
  return creator.role === 'admin' && profileOrgId(creator) === codeData.organizationId;
}

// How long a new profile must wait before minting invite codes: repairInviteJoin vets
// a profile that names an org within seconds of its creation, so an unvetted claim
// can't mint a code meanwhile. The sole member of an org (its creator or provisioned
// admin) doesn't wait.
const NEW_PROFILE_INVITE_COOLDOWN_MS = 10 * 60 * 1000;

// Validate invite code (replaces validateAccessCode)
exports.validateInviteCode = functions.https.onRequest(async (req, res) => {
  // Set CORS headers
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { inviteCode } = req.body;
    
    if (!inviteCode || typeof inviteCode !== 'string') {
      res.status(400).json({ valid: false, error: 'Invite code required' });
      return;
    }

    const normalized = inviteCode.trim().toUpperCase();
    
    // Query invite_codes collection
    const codesRef = db.collection('invite_codes');
    const snapshot = await codesRef.where('code', '==', normalized).limit(1).get();
    
    if (snapshot.empty) {
      res.status(200).json({ valid: false, error: 'Invalid invite code' });
      return;
    }
    
    const codeDoc = snapshot.docs[0];
    const codeData = codeDoc.data();
    
    // Validate code
    if (typeof codeData.organizationId !== 'string' || !codeData.organizationId) {
      res.status(200).json({ valid: false, error: 'Invalid invite code' });
      return;
    }

    if (!codeData.isActive || !(await codeCreatorStillAdmin(codeData))) {
      res.status(200).json({ valid: false, error: 'This invite code has been deactivated' });
      return;
    }

    // Check expiration
    if (codeData.expiresAt && codeData.expiresAt.toDate() < new Date()) {
      res.status(200).json({ valid: false, error: 'This invite code has expired' });
      return;
    }
    
    // Check usage limit
    if (codeData.maxUses && codeData.usedCount >= codeData.maxUses) {
      res.status(200).json({ valid: false, error: 'This invite code has reached its usage limit' });
      return;
    }
    
    // Get organization details. A code for an org that doesn't exist can't attach
    // anyone to anything, and its join intents would only confuse repairInviteJoin.
    const orgDoc = await findInviteOrgDoc(codeData.organizationId);
    if (!orgDoc) {
      res.status(200).json({ valid: false, error: 'Invalid invite code' });
      return;
    }
    const orgData = orgDoc.data();
    const orgName = orgData.name;

    // Check seat limit
    const maxSeats = orgData.maxSeats || 0;
    if (maxSeats > 0) {
      const [membersSnapshot, recentIntents] = await Promise.all([
        db.collection('users').where('organization_id', '==', codeData.organizationId).get(),
        db.collection(INTENTS_COLLECTION)
          .where('validatedAt', '>=', admin.firestore.Timestamp.fromMillis(Date.now() - WINDOW_BEFORE_MS))
          .get(),
      ]);
      // Someone who validated a code in the last few minutes is about to be attached by
      // repairInviteJoin, so their seat is already taken.
      const joining = recentIntents.docs.filter(d =>
        d.data().organizationId === codeData.organizationId && d.data().consumed === false).length;
      if (membersSnapshot.size >= maxSeats) {
        res.status(200).json({
          valid: false,
          error: `This organization has reached its seat limit (${maxSeats}). Contact the admin to upgrade the plan.`,
        });
        return;
      }
      if (membersSnapshot.size + joining >= maxSeats) {
        res.status(200).json({
          valid: false,
          error: 'Someone is joining this organization with its last open seat right now. Please try again in a few minutes.',
        });
        return;
      }
    }

    // Increment usage count
    await codesRef.doc(codeDoc.id).update({
      usedCount: admin.firestore.FieldValue.increment(1)
    });

    // Record a join intent for repairInviteJoin: live app builds create the new user's
    // profile without an organization_id, so the server attaches it from this record.
    // Best-effort only; a failure here must never change the response.
    try {
      await db.collection('invite_join_intents').add({
        code: normalized,
        inviteCodeId: codeDoc.id,
        organizationId: codeData.organizationId,
        role: codeData.role || 'member',
        validatedAt: admin.firestore.FieldValue.serverTimestamp(),
        consumed: false,
      });
    } catch (intentError) {
      console.error('Error recording invite join intent:', intentError);
    }
    
    res.status(200).json({
      valid: true,
      role: codeData.role,
      organizationId: codeData.organizationId,
      organizationName: orgName
    });
  } catch (error) {
    console.error('Error validating invite code:', error);
    res.status(500).json({ valid: false, error: 'Internal server error' });
  }
});

// Generate invite code (admin only)
exports.generateInviteCode = functions.https.onRequest(async (req, res) => {
  // Set CORS headers
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Verify authentication
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const userId = decodedToken.uid;
    
    // Check if user is admin (or super admin)
    const userDoc = await db.collection('users').doc(userId).get();
    const callerRole = userDoc.exists ? userDoc.data().role : null;
    if (!userDoc.exists || (callerRole !== 'admin' && callerRole !== 'super_admin')) {
      res.status(403).json({ error: 'Only admins can generate invite codes' });
      return;
    }
    const organizationId = profileOrgId(userDoc.data());
    if (!organizationId) {
      res.status(400).json({ error: 'Your account is not linked to an organization' });
      return;
    }
    // Only an org that exists and passed review can invite people, so an account that
    // names a fresh or made-up org id can't mint codes for it.
    const orgDoc = await findInviteOrgDoc(organizationId);
    const orgStatus = orgDoc ? orgDoc.data().status : null;
    if (!orgDoc || orgStatus === 'pending' || orgStatus === 'rejected') {
      res.status(403).json({ error: 'Your organization must be approved before it can invite members' });
      return;
    }
    if (callerRole !== 'super_admin' &&
        Date.now() - userDoc.createTime.toMillis() < NEW_PROFILE_INVITE_COOLDOWN_MS) {
      const members = await db.collection('users')
        .where('organization_id', '==', organizationId)
        .limit(2)
        .get();
      if (members.docs.some(d => d.id !== userId)) {
        res.status(403).json({ error: 'New accounts can create invite codes a few minutes after sign-up' });
        return;
      }
    }

    const { role, expiresInDays, maxUses } = req.body;

    // Validate role
    if (!role || !['admin', 'security', 'member'].includes(role)) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }
    // Only a super admin may mint codes that grant elevated roles. The app always
    // requests 'member', so this does not affect any live-client flow.
    if (role !== 'member' && callerRole !== 'super_admin') {
      res.status(403).json({ error: 'You can only create member invite codes' });
      return;
    }
    
    // Generate unique code
    let code;
    let isUnique = false;
    const codesRef = db.collection('invite_codes');
    
    while (!isUnique) {
      code = generateInviteCode();
      const existing = await codesRef.where('code', '==', code).limit(1).get();
      isUnique = existing.empty;
    }
    
    // Every code expires and has a use limit: at most 30 days and 50 uses (the app asks
    // for 30 days and 10 uses).
    const days = Math.min(Math.max(Number(expiresInDays) || 30, 1), 30);
    const uses = Math.min(Math.max(Number(maxUses) || 10, 1), 50);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    // Create invite code document
    const inviteData = {
      code,
      organizationId,
      role,
      createdBy: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      maxUses: uses,
      usedCount: 0,
      isActive: true
    };

    await codesRef.add(inviteData);

    res.status(200).json({
      success: true,
      code,
      role,
      expiresAt: expiresAt.toISOString(),
      maxUses: uses
    });
  } catch (error) {
    console.error('Error generating invite code:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================
// ORGANIZATION VERIFICATION FUNCTIONS
// =============================================

// Read from environment variable. Set via functions/.env file (Firebase Functions v2 loads it automatically)
// or via: firebase functions:config:set google.places_api_key="YOUR_KEY"
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const AUTO_APPROVE_THRESHOLD = 60;

const FREE_EMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'mail.com', 'protonmail.com', 'zoho.com', 'yandex.com',
  'gmx.com', 'live.com', 'msn.com', 'comcast.net', 'att.net',
  'verizon.net', 'me.com', 'mac.com',
];

// Helper: Verify auth token and return userId
async function verifyAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const idToken = authHeader.split('Bearer ')[1];
  const decodedToken = await admin.auth().verifyIdToken(idToken);
  return decodedToken.uid;
}

// Helper: Set CORS headers
function setCorsHeaders(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

// Helper: the caller's organization id (the org's `id` FIELD value, e.g. 'org_<ms>'),
// supporting both field spellings. null when the caller has no profile or org.
async function getCallerOrgId(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) return null;
  const data = userDoc.data();
  return data.organization_id || data.organizationId || null;
}

// Helper: resolve an organization by its doc id, falling back to its `id` field.
// Returns { ref, data, docId } or null. Mirrors verifyOrganization's lookup so every
// verification endpoint accepts the same organizationId the client already sends.
async function resolveOrg(organizationId) {
  const byDoc = await db.collection('organizations').doc(organizationId).get();
  if (byDoc.exists) return { ref: byDoc.ref, data: byDoc.data(), docId: byDoc.id };
  const q = await db.collection('organizations').where('id', '==', organizationId).limit(1).get();
  if (!q.empty) return { ref: q.docs[0].ref, data: q.docs[0].data(), docId: q.docs[0].id };
  return null;
}

// Helper: true when the caller belongs to the organization (compares the org's `id`
// field to the caller's stored org id — the membership model the whole app uses).
function callerBelongsToOrg(callerOrgId, orgData) {
  return !!callerOrgId && !!orgData && orgData.id === callerOrgId;
}

// Helper: Check Google Places for a place of worship
async function checkGooglePlaces(orgName, address, lat, lng) {
  const result = {
    status: 'failed',
    score: 0,
    placeId: null,
    details: '',
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    const query = encodeURIComponent(`${orgName} ${address}`);
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id,name,formatted_address,types,geometry&key=${GOOGLE_PLACES_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' || !data.candidates || data.candidates.length === 0) {
      result.details = 'No matching place found on Google Maps';
      return result;
    }

    const place = data.candidates[0];
    const worshipTypes = ['church', 'place_of_worship', 'hindu_temple', 'mosque', 'synagogue'];
    const isWorshipPlace = place.types && place.types.some(t => worshipTypes.includes(t));

    // Check location proximity (within ~500m)
    let locationMatch = false;
    if (place.geometry && place.geometry.location) {
      const placeLat = place.geometry.location.lat;
      const placeLng = place.geometry.location.lng;
      const distance = Math.sqrt(Math.pow(placeLat - lat, 2) + Math.pow(placeLng - lng, 2));
      locationMatch = distance < 0.005; // ~500m
    }

    if (isWorshipPlace && locationMatch) {
      result.status = 'passed';
      result.score = 30;
      result.placeId = place.place_id;
      result.details = `Found "${place.name}" as place of worship at matching location`;
    } else if (locationMatch) {
      result.status = 'passed';
      result.score = 20;
      result.placeId = place.place_id;
      result.details = `Found "${place.name}" at matching location (not categorized as place of worship)`;
    } else if (isWorshipPlace) {
      result.status = 'passed';
      result.score = 10;
      result.placeId = place.place_id;
      result.details = `Found "${place.name}" as place of worship but location differs`;
    } else {
      result.details = `Found "${place.name}" but no worship type or location match`;
    }
  } catch (error) {
    console.error('Google Places check error:', error);
    result.details = 'Error contacting Google Places API';
  }

  return result;
}

// Helper: Check EIN via ProPublica Nonprofit Explorer
async function checkEIN(ein, orgName) {
  const result = {
    status: 'skipped',
    score: 0,
    nonprofitName: null,
    details: '',
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (!ein) {
    result.details = 'EIN not provided';
    return result;
  }

  try {
    const cleanEIN = ein.replace(/\D/g, '');
    if (cleanEIN.length !== 9) {
      result.status = 'failed';
      result.details = 'Invalid EIN format (must be 9 digits)';
      return result;
    }

    const url = `https://projects.propublica.org/nonprofits/api/v2/organizations/${cleanEIN}.json`;
    const response = await fetch(url);

    if (response.status === 404) {
      result.status = 'failed';
      result.details = 'EIN not found in IRS nonprofit database';
      return result;
    }

    const data = await response.json();
    const org = data.organization;

    if (!org) {
      result.status = 'failed';
      result.details = 'Invalid response from nonprofit database';
      return result;
    }

    result.nonprofitName = org.name;
    const isReligious = org.ntee_code && org.ntee_code.startsWith('X');

    // Check name similarity (basic)
    const orgNameLower = orgName.toLowerCase();
    const nonprofitNameLower = org.name.toLowerCase();
    const nameMatch = orgNameLower.includes(nonprofitNameLower) ||
                      nonprofitNameLower.includes(orgNameLower) ||
                      orgNameLower.split(' ').some(word =>
                        word.length > 3 && nonprofitNameLower.includes(word)
                      );

    if (nameMatch || isReligious) {
      result.status = 'passed';
      result.score = 30;
      result.details = `Found "${org.name}" (${isReligious ? 'Religious org' : 'Nonprofit'}) - EIN verified`;
    } else {
      result.status = 'passed';
      result.score = 15;
      result.details = `Found "${org.name}" but name doesn't closely match "${orgName}"`;
    }
  } catch (error) {
    console.error('EIN check error:', error);
    result.status = 'failed';
    result.details = 'Error checking nonprofit database';
  }

  return result;
}

// Helper: Recalculate score and possibly auto-approve
async function recalculateAndUpdateStatus(orgId) {
  const checksDoc = await db.collection('organizations').doc(orgId)
    .collection('verification').doc('checks').get();

  if (!checksDoc.exists) return;

  const checks = checksDoc.data();
  const totalScore = (checks.googlePlaces?.score || 0) +
                     (checks.einVerification?.score || 0) +
                     (checks.emailDomain?.score || 0) +
                     (checks.phoneSms?.score || 0);

  // A super admin's rejection stands: a new score never auto-approves a rejected org.
  const orgDoc = await db.collection('organizations').doc(orgId).get();
  const rejected = orgDoc.exists && orgDoc.data().status === 'rejected';

  const autoApproved = !rejected && totalScore >= AUTO_APPROVE_THRESHOLD;

  await db.collection('organizations').doc(orgId)
    .collection('verification').doc('checks').update({
      totalScore,
      autoApproved,
    });

  if (autoApproved) {
    await db.collection('organizations').doc(orgId).update({
      status: 'verified',
      verificationScore: totalScore,
      verificationCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    await db.collection('organizations').doc(orgId).update({
      verificationScore: totalScore,
    });
  }

  return { totalScore, autoApproved, rejected };
}

// The status the confirm endpoints report after recalculateAndUpdateStatus.
function statusAfterRecalculation(result) {
  if (result.rejected) return 'rejected';
  return result.autoApproved ? 'verified' : 'pending';
}

// Main verification orchestrator
exports.verifyOrganization = functions.https.onRequest(async (req, res) => {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const userId = await verifyAuthToken(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { organizationId, ein, orgEmail, phone, website } = req.body;
    if (!organizationId) {
      res.status(400).json({ error: 'organizationId required' });
      return;
    }

    // Get the organization document
    const orgDoc = await db.collection('organizations').doc(organizationId).get();
    if (!orgDoc.exists) {
      // Try querying by id field (existing pattern)
      const orgQuery = await db.collection('organizations').where('id', '==', organizationId).limit(1).get();
      if (orgQuery.empty) {
        res.status(404).json({ error: 'Organization not found' });
        return;
      }
      var orgRef = orgQuery.docs[0].ref;
      var orgData = orgQuery.docs[0].data();
      var orgDocId = orgQuery.docs[0].id;
    } else {
      var orgRef = orgDoc.ref;
      var orgData = orgDoc.data();
      var orgDocId = orgDoc.id;
    }

    // Only a member of this organization may submit it for verification. This blocks
    // cross-org abuse: knocking any org back to 'pending' and burning Places quota.
    const callerOrg = await getCallerOrgId(userId);
    if (!callerBelongsToOrg(callerOrg, orgData)) {
      res.status(403).json({ error: 'You can only verify your own organization' });
      return;
    }
    // Never downgrade an organization that is already verified/active.
    if (orgData.status === 'verified' || orgData.status === 'Active') {
      res.status(200).json({ status: orgData.status, score: orgData.verificationScore || 0, alreadyVerified: true });
      return;
    }
    // A super admin's rejection stands: re-scoring must not move a rejected org back to
    // 'pending' or auto-approve it. No app version offers verification from the Rejected screen.
    if (orgData.status === 'rejected') {
      res.status(409).json({ error: 'Organization was not approved', status: 'rejected' });
      return;
    }

    // Run Google Places check (always)
    const placesResult = await checkGooglePlaces(
      orgData.name, orgData.address, orgData.latitude, orgData.longitude
    );

    // Run EIN check (if provided)
    const einResult = await checkEIN(ein, orgData.name);

    // Email and phone are verified separately (async flow)
    const emailResult = {
      status: orgEmail ? 'pending' : 'skipped',
      score: 0,
      domain: orgEmail ? orgEmail.split('@')[1] : null,
      details: orgEmail ? 'Awaiting email verification' : 'Organization email not provided',
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const phoneResult = {
      status: phone ? 'pending' : 'skipped',
      score: 0,
      details: phone ? 'Awaiting phone verification' : 'Phone not provided',
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const totalScore = placesResult.score + einResult.score;
    const autoApproved = totalScore >= AUTO_APPROVE_THRESHOLD;

    // Store verification checks
    await db.collection('organizations').doc(orgDocId)
      .collection('verification').doc('checks').set({
        googlePlaces: placesResult,
        einVerification: einResult,
        emailDomain: emailResult,
        phoneSms: phoneResult,
        totalScore,
        autoApproved,
      });

    // Update org status
    const newStatus = autoApproved ? 'verified' : 'pending';
    await orgRef.update({
      status: newStatus,
      verificationScore: totalScore,
      ein: ein || null,
      website: website || null,
      orgEmail: orgEmail || null,
      phone: phone || null,
      verificationSubmittedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(autoApproved ? { verificationCompletedAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
    });

    res.status(200).json({
      status: newStatus,
      score: totalScore,
      checks: {
        googlePlaces: { status: placesResult.status, score: placesResult.score, details: placesResult.details },
        einVerification: { status: einResult.status, score: einResult.score, details: einResult.details },
        emailDomain: { status: emailResult.status, score: emailResult.score },
        phoneSms: { status: phoneResult.status, score: phoneResult.score },
      },
    });
  } catch (error) {
    console.error('Error verifying organization:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send organization email verification code
exports.sendOrgEmailVerification = functions.https.onRequest(async (req, res) => {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const userId = await verifyAuthToken(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { organizationId, email } = req.body;
    if (!organizationId || !email) {
      res.status(400).json({ error: 'organizationId and email required' });
      return;
    }

    // Only a member of this org may request a verification email for it.
    const org = await resolveOrg(organizationId);
    if (!org || !callerBelongsToOrg(await getCallerOrgId(userId), org.data)) {
      res.status(403).json({ error: 'You can only verify your own organization' });
      return;
    }

    // Check for free email domains
    const domain = email.split('@')[1]?.toLowerCase();
    if (FREE_EMAIL_DOMAINS.includes(domain)) {
      res.status(400).json({ error: 'Please use your organization email, not a free email provider' });
      return;
    }

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store code in verification subcollection
    await db.collection('organizations').doc(organizationId)
      .collection('verification').doc('emailCode').set({
        code,
        email,
        domain,
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        attempts: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Send email via Firestore mail collection (Firebase Trigger Email extension)
    await db.collection('mail').add({
      to: email,
      message: {
        subject: 'HolyGuard - Organization Email Verification',
        text: `Your verification code is: ${code}\n\nThis code expires in 1 hour.\n\nIf you did not request this, please ignore this email.`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #8B4513;">HolyGuard Verification</h2>
          <p>Your organization email verification code is:</p>
          <div style="background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #2F2F2F;">${code}</span>
          </div>
          <p style="color: #666;">This code expires in 1 hour.</p>
          <p style="color: #999; font-size: 12px;">If you did not request this, please ignore this email.</p>
        </div>`,
      },
    });

    res.status(200).json({ success: true, message: 'Verification code sent' });
  } catch (error) {
    console.error('Error sending org email verification:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Confirm organization email verification code
exports.confirmOrgEmail = functions.https.onRequest(async (req, res) => {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const userId = await verifyAuthToken(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { organizationId, code } = req.body;
    if (!organizationId || !code) {
      res.status(400).json({ error: 'organizationId and code required' });
      return;
    }

    // Only a member of this org may confirm its email code.
    const org = await resolveOrg(organizationId);
    if (!org || !callerBelongsToOrg(await getCallerOrgId(userId), org.data)) {
      res.status(403).json({ error: 'You can only verify your own organization' });
      return;
    }

    const codeRef = db.collection('organizations').doc(organizationId)
      .collection('verification').doc('emailCode');
    const codeDoc = await codeRef.get();

    if (!codeDoc.exists) {
      res.status(400).json({ error: 'No verification code found. Please request a new one.' });
      return;
    }

    const codeData = codeDoc.data();

    // Check attempts
    if (codeData.attempts >= 5) {
      res.status(400).json({ error: 'Too many attempts. Please request a new code.' });
      return;
    }

    // Check expiry
    if (codeData.expiresAt.toDate() < new Date()) {
      res.status(400).json({ error: 'Code has expired. Please request a new one.' });
      return;
    }

    // Increment attempts
    await codeRef.update({ attempts: admin.firestore.FieldValue.increment(1) });

    // Verify code
    if (codeData.code !== code.trim()) {
      res.status(400).json({ error: 'Invalid code' });
      return;
    }

    // Update email verification check
    const checksRef = db.collection('organizations').doc(organizationId)
      .collection('verification').doc('checks');

    await checksRef.update({
      emailDomain: {
        status: 'passed',
        score: 25,
        domain: codeData.domain,
        details: `Verified ownership of ${codeData.email}`,
        checkedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });

    // Recalculate score and possibly auto-approve
    const result = await recalculateAndUpdateStatus(organizationId);

    res.status(200).json({
      success: true,
      totalScore: result.totalScore,
      autoApproved: result.autoApproved,
      status: statusAfterRecalculation(result),
    });
  } catch (error) {
    console.error('Error confirming org email:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Confirm phone verification (after client-side Firebase Auth phone flow)
exports.confirmPhoneVerification = functions.https.onRequest(async (req, res) => {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const userId = await verifyAuthToken(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { organizationId, phoneNumber } = req.body;
    if (!organizationId || !phoneNumber) {
      res.status(400).json({ error: 'organizationId and phoneNumber required' });
      return;
    }

    // Only a member of this org may record its phone verification.
    const org = await resolveOrg(organizationId);
    if (!org || !callerBelongsToOrg(await getCallerOrgId(userId), org.data)) {
      res.status(403).json({ error: 'You can only verify your own organization' });
      return;
    }

    // Mask phone for storage
    const maskedPhone = phoneNumber.replace(/\d(?=\d{4})/g, '*');

    // Update phone verification check
    const checksRef = db.collection('organizations').doc(organizationId)
      .collection('verification').doc('checks');

    await checksRef.update({
      phoneSms: {
        status: 'passed',
        score: 15,
        details: `Phone verified: ${maskedPhone}`,
        checkedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });

    // Recalculate score and possibly auto-approve
    const result = await recalculateAndUpdateStatus(organizationId);

    res.status(200).json({
      success: true,
      totalScore: result.totalScore,
      autoApproved: result.autoApproved,
      status: statusAfterRecalculation(result),
    });
  } catch (error) {
    console.error('Error confirming phone verification:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Super admin: Review organization (approve or reject)
exports.reviewOrganization = functions.https.onRequest(async (req, res) => {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const userId = await verifyAuthToken(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Verify super_admin role
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists || userDoc.data().role !== 'super_admin') {
      res.status(403).json({ error: 'Only super admins can review organizations' });
      return;
    }

    const { organizationId, action, reason } = req.body;
    if (!organizationId || !action || !['approve', 'reject'].includes(action)) {
      res.status(400).json({ error: 'organizationId and action (approve/reject) required' });
      return;
    }

    const newStatus = action === 'approve' ? 'verified' : 'rejected';

    // Update organization status
    await db.collection('organizations').doc(organizationId).update({
      status: newStatus,
      ...(action === 'reject' ? { rejectionReason: reason || 'Did not meet verification requirements' } : {}),
      verificationCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update verification checks with reviewer info
    const checksRef = db.collection('organizations').doc(organizationId)
      .collection('verification').doc('checks');
    const checksDoc = await checksRef.get();
    if (checksDoc.exists) {
      await checksRef.update({
        reviewedBy: userId,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(action === 'approve' ? { autoApproved: false } : {}),
      });
    }

    res.status(200).json({
      success: true,
      status: newStatus,
      organizationId,
    });
  } catch (error) {
    console.error('Error reviewing organization:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =====================================================================================
// Apple In-App Purchase — receipt validation and Server Notifications V2
//
// validateAppleReceipt: called by the client after a sandbox/production purchase with
//   { jws } (1.2.8 also sends productId, which is ignored). Verifies the StoreKit 2
//   signed transaction, then writes the plan to the caller's org doc. A refunded or
//   revoked transaction is refused; a grandfathered org only gets the Apple link fields
//   (no plan, seat cap or status); an org already paying through a different, still
//   running subscription is refused with 409 instead of being silently relinked.
//
// appleNotifications:   App Store Server Notifications V2 endpoint configured in
//   App Store Connect → App Information → App Store Server Notifications.
//   Decodes and verifies the signed JWS payload, then keeps Firestore in sync with
//   renewals, cancellations, expirations, refunds, and product changes.
//
// Set in functions/.env:
//   APPLE_SHARED_SECRET=<App-Specific Shared Secret from App Store Connect>
// =====================================================================================
const crypto = require('crypto');

const PRODUCT_TO_PLAN = {
  '001': { plan: 'individual', seats: 3 },
  '002': { plan: 'team', seats: 15 },
  '003': { plan: 'enterprise', seats: 30 },
};

const APPLE_VERIFY_PRODUCTION = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_VERIFY_SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt';

// Apple Root CA - G3 (ECC). Used to anchor App Store Server Notifications V2 JWS
// signature chains. Public certificate from https://www.apple.com/certificateauthority/
const APPLE_ROOT_CA_G3 = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

async function findOrgRefForUser(firebaseUid) {
  const userDoc = await db.collection('users').doc(firebaseUid).get();
  if (!userDoc.exists) return null;
  const orgId = profileOrgId(userDoc.data());
  if (!orgId) return null;
  return findOrgRef(orgId);
}

async function findOrgRef(orgId) {
  const orgsSnapshot = await db.collection('organizations').where('id', '==', orgId).limit(1).get();
  if (!orgsSnapshot.empty) return orgsSnapshot.docs[0].ref;
  const directRef = db.collection('organizations').doc(orgId);
  const directSnap = await directRef.get();
  return directSnap.exists ? directRef : null;
}

async function findOrgRefByOriginalTxId(originalTransactionId) {
  const snap = await db.collection('organizations')
    .where('appleOriginalTransactionId', '==', originalTransactionId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].ref;
}

// True when the org is linked to a DIFFERENT Apple subscription that is still running:
// the org is active on it and its last known expiry is in the future. A refunded or
// revoked one (appleNotifications set the org to 'expired') doesn't count, so the org
// can subscribe again.
function hasOtherActiveAppleLink(org, originalTransactionId, nowMs) {
  const linked = org.appleOriginalTransactionId;
  return typeof linked === 'string' && linked !== '' &&
    linked !== originalTransactionId &&
    Number(org.appleExpiresDateMs) > nowMs &&
    org.subscriptionStatus === 'active';
}

async function verifyReceiptWithApple(receipt) {
  const sharedSecret = process.env.APPLE_SHARED_SECRET;
  if (!sharedSecret) {
    throw new Error('APPLE_SHARED_SECRET not configured');
  }
  const body = {
    'receipt-data': receipt,
    password: sharedSecret,
    'exclude-old-transactions': true,
  };
  let response = await fetch(APPLE_VERIFY_PRODUCTION, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = await response.json();
  // 21007 = receipt is from sandbox but sent to production. Retry against sandbox.
  if (json && json.status === 21007) {
    response = await fetch(APPLE_VERIFY_SANDBOX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    json = await response.json();
  }
  return json;
}

function pickLatestSubscription(verifyResponse) {
  const latest = verifyResponse?.latest_receipt_info;
  if (!Array.isArray(latest) || latest.length === 0) return null;
  // Restrict to our products and pick the one with the largest expires_date_ms.
  const ours = latest.filter(tx => PRODUCT_TO_PLAN[tx.product_id]);
  if (!ours.length) return null;
  ours.sort((a, b) => Number(b.expires_date_ms || 0) - Number(a.expires_date_ms || 0));
  return ours[0];
}

exports.validateAppleReceipt = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const idToken = authHeader.slice('Bearer '.length);
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const { jws } = req.body || {};
    if (!jws || typeof jws !== 'string') {
      return res.status(400).json({ error: 'Missing jws' });
    }

    // Only an org admin buys or restores the org's plan (the paywall is admin-only).
    const callerDoc = await db.collection('users').doc(uid).get();
    const callerRole = callerDoc.exists ? callerDoc.data().role : null;
    if (callerRole !== 'admin' && callerRole !== 'super_admin') {
      return res.status(403).json({ valid: false, error: 'Only an organization admin can activate a subscription' });
    }

    const orgRef = await findOrgRefForUser(uid);
    if (!orgRef) {
      return res.status(404).json({ valid: false, error: 'No organization for user' });
    }

    // Verify the Apple-signed transaction JWS and extract transaction info.
    // This is the same JWS verification path appleNotifications uses — same
    // cert chain rooted at Apple Root CA G3, same signature check.
    let tx;
    try {
      tx = decodeAndVerifyJWS(jws);
    } catch (error) {
      console.warn('Transaction JWS verification failed:', error.message);
      return res.status(200).json({ valid: false, error: 'Invalid signature' });
    }

    const productId = tx.productId;
    const originalTransactionId = tx.originalTransactionId;
    const expiresMs = Number(tx.expiresDate || 0);

    // Every App Store transaction is signed by the same Apple chain, so a transaction
    // from another developer's app with a matching product id would otherwise verify.
    if (tx.bundleId !== APP_BUNDLE_ID || tx.type !== 'Auto-Renewable Subscription') {
      return res.status(200).json({ valid: false, error: 'Not a HolyGuard subscription' });
    }
    if (!PRODUCT_TO_PLAN[productId]) {
      return res.status(200).json({ valid: false, error: 'Unknown product' });
    }
    if (!originalTransactionId) {
      return res.status(200).json({ valid: false, error: 'Missing originalTransactionId' });
    }
    // A refunded or revoked transaction grants nothing, even before it expires.
    if (tx.revocationDate) {
      return res.status(200).json({ valid: false, error: 'Subscription revoked' });
    }
    if (!expiresMs || expiresMs <= Date.now()) {
      return res.status(200).json({ valid: false, error: 'Subscription expired', expiresDateMs: expiresMs });
    }

    // Reject replay: a subscription already linked to a different org cannot be
    // used to activate this one (one paid/sandbox subscription = one org).
    const existingOrgRef = await findOrgRefByOriginalTxId(originalTransactionId);
    if (existingOrgRef && existingOrgRef.path !== orgRef.path) {
      return res.status(200).json({ valid: false, error: 'This subscription is already linked to another organization' });
    }

    const planInfo = PRODUCT_TO_PLAN[productId];
    const nowIso = new Date().toISOString();
    const org = (await orgRef.get()).data() || {};
    const appleLink = {
      appleOriginalTransactionId: originalTransactionId,
      appleProductId: productId,
      appleExpiresDateMs: expiresMs || null,
      appleEnvironment: tx.environment || null,
    };
    const success = {
      valid: true,
      productId,
      plan: planInfo.plan,
      expiresDateMs: expiresMs || null,
    };

    // The org pays through another, still-running subscription. Relinking would orphan
    // that one: its renewals and expiry would no longer find this org.
    const otherActiveLink = hasOtherActiveAppleLink(org, originalTransactionId, Date.now());

    // A grandfathered org has no plan or seat cap and never needs a subscription to stay
    // active, so a purchase only records the Apple link (when that link is free). Success
    // either way, so the client finishes the transaction.
    if (org.grandfathered === true) {
      if (!otherActiveLink) {
        await orgRef.update({ ...appleLink, subscriptionUpdatedAt: nowIso });
      }
      return res.status(200).json({ ...success, grandfathered: true });
    }

    if (otherActiveLink) {
      return res.status(409).json({
        valid: false,
        error: 'This organization already has an active App Store subscription from another Apple ID. ' +
          'It stays in effect until it expires or is cancelled; contact support if you need to change who pays.',
      });
    }

    await orgRef.update({
      subscriptionPlan: planInfo.plan,
      subscriptionStatus: 'active',
      maxSeats: planInfo.seats,
      subscribedAt: nowIso,
      subscriptionUpdatedAt: nowIso,
      ...appleLink,
    });

    return res.status(200).json(success);
  } catch (error) {
    console.error('validateAppleReceipt error:', error);
    return res.status(500).json({ valid: false, error: 'Internal error' });
  }
});

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

const APP_BUNDLE_ID = 'com.lonestardevops.holyguard';

// DER of Apple's marker extension OID 1.2.840.113635.100.6.<n>.1. App Store signing
// certificates carry n=11 and the Apple WWDR intermediate n=2; Apple's own server
// library requires both, so a certificate Apple issued for anything else (Apple Pay,
// push, code signing) under the same root can't sign a transaction.
function appleMarkerOid(n) {
  return Buffer.from([0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, n, 0x01]);
}
const APP_STORE_SIGNING_OID = appleMarkerOid(0x0b);
const APPLE_WWDR_INTERMEDIATE_OID = appleMarkerOid(0x02);

function decodeAndVerifyJWS(jws) {
  const parts = jws.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWS');
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
  if (header.alg !== 'ES256') {
    throw new Error(`Unsupported alg: ${header.alg}`);
  }
  if (!Array.isArray(header.x5c) || header.x5c.length !== 3) {
    throw new Error('x5c must hold the leaf, intermediate and root certificates');
  }

  const certs = header.x5c.map(c => new crypto.X509Certificate(Buffer.from(c, 'base64')));
  const leaf = certs[0];
  const intermediate = certs[1];
  const claimedRoot = certs[2];
  const trustedRoot = new crypto.X509Certificate(APPLE_ROOT_CA_G3);

  if (intermediate && !leaf.verify(intermediate.publicKey)) {
    throw new Error('Leaf cert not signed by intermediate');
  }
  if (claimedRoot && intermediate && !intermediate.verify(claimedRoot.publicKey)) {
    throw new Error('Intermediate cert not signed by claimed root');
  }
  // The claimed root must byte-for-byte match Apple Root CA - G3.
  const claimedRootDer = claimedRoot ? claimedRoot.raw : leaf.raw;
  if (!Buffer.from(claimedRootDer).equals(Buffer.from(trustedRoot.raw))) {
    throw new Error('Root cert does not match trusted Apple Root CA G3');
  }
  if (!Buffer.from(intermediate.raw).includes(APPLE_WWDR_INTERMEDIATE_OID)) {
    throw new Error('Intermediate cert is not the Apple WWDR intermediate');
  }
  if (!Buffer.from(leaf.raw).includes(APP_STORE_SIGNING_OID)) {
    throw new Error('Leaf cert is not an App Store signing certificate');
  }

  const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  const valid = crypto.verify(
    'sha256',
    signedData,
    { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
    signature,
  );
  if (!valid) {
    throw new Error('JWS signature verification failed');
  }

  return JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
}

exports.appleNotifications = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let notification;
  try {
    const { signedPayload } = req.body || {};
    if (!signedPayload || typeof signedPayload !== 'string') {
      return res.status(400).json({ error: 'Missing signedPayload' });
    }
    notification = decodeAndVerifyJWS(signedPayload);
  } catch (error) {
    console.error('Failed to verify Apple notification JWS:', error.message);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const notificationType = notification.notificationType;
    const subtype = notification.subtype;
    const data = notification.data || {};

    let txInfo = null;
    if (data.signedTransactionInfo) {
      try {
        txInfo = decodeAndVerifyJWS(data.signedTransactionInfo);
      } catch (error) {
        console.error('Failed to decode signedTransactionInfo:', error.message);
      }
    }

    const originalTransactionId = txInfo?.originalTransactionId;
    if (!originalTransactionId) {
      console.warn(`Notification ${notificationType} missing originalTransactionId`);
      return res.status(200).json({ ok: true, ignored: 'no originalTransactionId' });
    }
    if (txInfo.bundleId !== APP_BUNDLE_ID) {
      console.warn(`Notification ${notificationType} for another app (${txInfo.bundleId}), ignored`);
      return res.status(200).json({ ok: true, ignored: 'other app' });
    }

    const orgRef = await findOrgRefByOriginalTxId(originalTransactionId);
    if (!orgRef) {
      console.warn(`No org for originalTransactionId ${originalTransactionId} on ${notificationType}`);
      return res.status(200).json({ ok: true, ignored: 'no org matched' });
    }
    // A grandfathered org has no plan or seat cap, even if an old Apple subscription
    // of its admin keeps renewing.
    const grandfathered = (await orgRef.get()).data()?.grandfathered === true;

    const productId = txInfo?.productId;
    const planInfo = productId ? PRODUCT_TO_PLAN[productId] : null;
    const expiresDateMs = txInfo?.expiresDate ? Number(txInfo.expiresDate) : null;
    const nowIso = new Date().toISOString();

    // The org is now active on txInfo's product.
    const activePlanPatch = () => {
      const patch = {
        subscriptionStatus: 'active',
        subscriptionUpdatedAt: nowIso,
        appleOriginalTransactionId: originalTransactionId,
      };
      if (planInfo && !grandfathered) {
        patch.subscriptionPlan = planInfo.plan;
        patch.maxSeats = planInfo.seats;
      }
      if (productId) patch.appleProductId = productId;
      if (expiresDateMs) patch.appleExpiresDateMs = expiresDateMs;
      return patch;
    };

    switch (notificationType) {
      case 'SUBSCRIBED':
      case 'DID_RENEW':
      case 'INTERACTIVE_RENEWAL':
      case 'OFFER_REDEEMED': {
        await orgRef.update(activePlanPatch());
        break;
      }
      case 'DID_CHANGE_RENEWAL_STATUS': {
        // AUTO_RENEW_DISABLED = user cancelled; access continues until expiry.
        // AUTO_RENEW_ENABLED = uncancelled.
        if (subtype === 'AUTO_RENEW_DISABLED') {
          await orgRef.update({
            subscriptionCancelledAt: nowIso,
            subscriptionUpdatedAt: nowIso,
          });
        } else if (subtype === 'AUTO_RENEW_ENABLED') {
          await orgRef.update({
            subscriptionCancelledAt: admin.firestore.FieldValue.delete(),
            subscriptionUpdatedAt: nowIso,
          });
        }
        break;
      }
      case 'DID_CHANGE_RENEWAL_PREF': {
        // An UPGRADE takes effect immediately (a new billing period on the new product),
        // and txInfo is that new transaction, so apply its plan and seats now. A DOWNGRADE
        // takes effect at the next renewal, which arrives as DID_RENEW.
        if (subtype === 'UPGRADE' && planInfo && txInfo.isUpgraded !== true) {
          await orgRef.update(activePlanPatch());
        } else {
          await orgRef.update({ subscriptionUpdatedAt: nowIso });
        }
        break;
      }
      case 'EXPIRED':
      case 'GRACE_PERIOD_EXPIRED': {
        await orgRef.update({
          subscriptionStatus: 'expired',
          subscriptionUpdatedAt: nowIso,
        });
        break;
      }
      case 'DID_FAIL_TO_RENEW': {
        // Apple retries during grace period. Record billing issue but don't expire yet
        // unless subtype indicates no grace period applies.
        const patch = {
          subscriptionBillingIssueAt: nowIso,
          subscriptionUpdatedAt: nowIso,
        };
        if (subtype === 'GRACE_PERIOD' /* still in grace */) {
          // leave status active
        } else {
          patch.subscriptionStatus = 'expired';
        }
        await orgRef.update(patch);
        break;
      }
      case 'REFUND':
      case 'REVOKE': {
        await orgRef.update({
          subscriptionStatus: 'expired',
          subscriptionUpdatedAt: nowIso,
        });
        break;
      }
      case 'TEST': {
        console.log('Apple notification TEST received');
        return res.status(200).json({ ok: true, test: true });
      }
      default: {
        console.log(`Apple notification ${notificationType} (${subtype || 'no subtype'}) — no state change applied`);
        break;
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('appleNotifications handler error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// =====================================================================================
// Invite join repair
//
// repairInviteJoin: live app builds (v1.2.7) create users/{uid} with role '' and
//   organization_id '' right after validateInviteCode succeeds, so new members land in
//   no org. When exactly that sign-up profile is created, attach it to the org from the
//   matching invite_join_intents records (written by validateInviteCode above), or flag
//   it in invite_join_review/{uid} when they don't name a single org and role. Any other
//   doc is left alone. Logic lives in inviteJoinRepair.js.
// =====================================================================================
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { createRepairInviteJoinHandler } = require('./inviteJoinRepair');

exports.repairInviteJoin = onDocumentCreated(
  {
    document: 'users/{uid}',
    database: '(default)',
    region: 'us-central1', // must match the Firestore database location
    // A failed run is redelivered: an unvetted claim must not keep its access. Both
    // branches re-read the profile in their transactions, so a rerun is a no-op.
    retry: true,
  },
  createRepairInviteJoinHandler({
    db,
    FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp,
    logger: console,
  })
);

// =====================================================================================
// Org profile change log
//
// recordOrgProfileChange: an org's admin can change its name, address and map pin, and a
//   verified org keeps its "Verified" badge on everyone's map afterwards. Every change to
//   those fields is recorded in org_profile_changes (old and new values, who, when); the
//   ones the owner should re-check are flagged, for scripts/org-profile-changes.js to
//   list. Updates that touch none of them cost nothing. Logic lives in
//   orgProfileChanges.js.
// =====================================================================================
const { onDocumentUpdatedWithAuthContext } = require('firebase-functions/v2/firestore');
const { createRecordOrgProfileChangeHandler } = require('./orgProfileChanges');

exports.recordOrgProfileChange = onDocumentUpdatedWithAuthContext(
  {
    document: 'organizations/{orgId}',
    database: '(default)',
    region: 'us-central1', // must match the Firestore database location
    // A failed run is redelivered so no change goes unrecorded. The record id comes from
    // the org doc's update time, so a rerun finds its record and adds nothing.
    retry: true,
  },
  createRecordOrgProfileChangeHandler({
    db,
    FieldValue: admin.firestore.FieldValue,
    logger: console,
  })
);

// =====================================================================================
// Account deletion
//
// deleteAccount: Settings -> Delete Account (and the gate screens) call this with a
//   recent ID token. It deletes everything the caller authored (alerts, watchlist
//   entries, resources, team messages, their conversations and DMs, DM invites, invite
//   codes, and those docs' photos in Storage), then users/{uid}, then the Auth user. The
//   only admin of an org with other members must first hand the org to one of them
//   (409 'last-admin', then a retry with newAdminUid). Logic lives in accountDeletion.js.
// =====================================================================================
const { createDeleteAccountHandler } = require('./accountDeletion');

// The app's default bucket (src/config/firebase.ts). Only photos in it are deleted.
const STORAGE_BUCKET = 'holyguard-app.firebasestorage.app';

exports.deleteAccount = functions.https.onRequest(
  { region: 'us-central1', timeoutSeconds: 300 },
  createDeleteAccountHandler({
    db,
    auth: {
      verifyIdToken: token => admin.auth().verifyIdToken(token),
      deleteUser: uid => admin.auth().deleteUser(uid),
    },
    storage: {
      bucketName: STORAGE_BUCKET,
      deleteFile: path => admin.storage().bucket(STORAGE_BUCKET).file(path).delete({ ignoreNotFound: true }),
      listFiles: async (prefix) => {
        const [files] = await admin.storage().bucket(STORAGE_BUCKET).getFiles({ prefix });
        return files.map(file => file.name);
      },
    },
    logger: console,
  })
);
