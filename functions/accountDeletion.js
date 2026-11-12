// =====================================================================================
// Account deletion
//
// deleteAccount (POST, 'Authorization: Bearer <Firebase ID token>', JSON
// { newAdminUid?: string }) deletes the caller's account and everything they authored.
// The app promises "All your data will be permanently deleted", and App Review requires
// that an account made in the app can be deleted from inside it (5.1.1(v)).
//
//   200 { deleted: true }
//   401 { error: 'unauthenticated' }        no or bad ID token
//   403 { error: 'requires-recent-login' }  the token's auth_time is over 5 minutes old
//   409 { error: 'last-admin', organizationName, members: [{ uid, name, role }] }
//                                           the caller is the only admin of an org that
//                                           still has other members: pick one of them
//                                           and retry with newAdminUid
//   400 { error: 'invalid-new-admin' }      newAdminUid isn't one of those members
//   405                                     not a POST
//   500 { error: 'internal' }
//
// What goes, in this order (each step pages through its query and deletes in batches):
//   alerts (reporterId), watchlist (createdBy), resources (postedBy), team_messages
//   (senderId), every conversation the caller takes part in (participants array-contains)
//   with all of its direct_messages, the caller's other direct_messages (senderId),
//   dm_invites sent by or to the caller (fromUserId / toUserId), invite_codes
//   (createdBy), then users/{uid}, and the Firebase Auth user LAST. The org doc stays.
//
// Photos: a deleted doc's imageUrl / imageUrls (Firebase Storage download URLs) are
// deleted before the doc itself, and so is every object under a deleted conversation's
// direct_messages/<id>/ folder and the caller's resources/<uid>_<ms>.jpg uploads (paths
// the app writes; see storage.rules). Nothing checks those URL fields when a doc is
// written, and every signed-in user can read every resource post, so a URL may point at
// someone else's photo. Only the folders the app uploads that doc's photos into count
// (see PHOTO_SCOPES), and an incidents/ or watchlist/ photo that another user's alert or
// watchlist entry in the same org still shows is kept.
//
// Resumable: every step only deletes what its query still finds, and a doc's photos go
// before the doc, so a retry after a partial failure picks up where the last run
// stopped. The Auth user goes last because a profile-less Auth user is what leaves bare
// {tos_accepted_at} profiles behind (the TOS screen's fallback re-creates one).
//
// No firebase imports here: db, auth, storage and logger are injected so the handler can
// run against in-memory fakes in tests.
// =====================================================================================

const RECENT_LOGIN_MS = 5 * 60 * 1000;

// Docs fetched and deleted per round trip. One batched write per page, well under
// Firestore's 500-operation limit.
const PAGE_SIZE = 400;

// Conversations per page: each one fans out to its own message query.
const CONVERSATION_PAGE_SIZE = 50;

// Safety stop for a query that keeps returning docs (400 x 1000 = 400,000 docs).
const MAX_PAGES = 1000;

// Storage deletes in flight at once.
const FILE_DELETE_CONCURRENCY = 10;

const ADMIN_ROLES = ['admin', 'super_admin'];

// Storage folders the app uploads into (storage.rules). A URL pointing anywhere else is
// never deleted.
const STORAGE_PREFIXES = ['incidents/', 'watchlist/', 'resources/', 'direct_messages/'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// A profile's org, read the way the security rules and index.js read it:
// organization_id when present, otherwise the legacy organizationId. '' when the
// profile has no usable org ('' or 'removed').
function profileOrgId(profile) {
  if (!profile) return '';
  const orgId = 'organization_id' in profile ? profile.organization_id : profile.organizationId;
  return isNonEmptyString(orgId) && orgId !== 'removed' ? orgId : '';
}

function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

// The object path of a Firebase Storage download URL in `bucketName`
// (https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<url-encoded path>?...), or
// null when the URL is anything else or points outside the app's upload folders.
function storagePathFromUrl(url, bucketName) {
  if (!isNonEmptyString(url) || !isNonEmptyString(bucketName)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'firebasestorage.googleapis.com') return null;
  const match = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return null;
  let bucket;
  let path;
  try {
    bucket = decodeURIComponent(match[1]);
    path = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (bucket !== bucketName) return null;
  if (!STORAGE_PREFIXES.some(prefix => path.startsWith(prefix) && path.length > prefix.length)) return null;
  if (path.split('/').some(part => part === '' || part === '.' || part === '..')) return null;
  return path;
}

// Storage paths of a doc's photos (imageUrl and imageUrls).
function imagePathsOf(data, bucketName) {
  if (!data) return [];
  const urls = [];
  if (typeof data.imageUrl === 'string') urls.push(data.imageUrl);
  if (Array.isArray(data.imageUrls)) urls.push(...data.imageUrls.filter(u => typeof u === 'string'));
  return urls.map(url => storagePathFromUrl(url, bucketName)).filter(Boolean);
}

// Where the app uploads each collection's photos, i.e. which of a deleted doc's photo
// paths may be deleted with it. (path, doc data, caller uid) -> bool.
//   alerts           incidents/ (the report and an admin's later edit both upload there)
//   watchlist        watchlist/, or incidents/ for an entry made from the reporter's alert
//   resources        resources/<uid>_ (the poster's own upload; posts are public, so a
//                    post's URL can be anyone's resource photo)
//   direct_messages  direct_messages/<the message's own conversationId>/
const PHOTO_SCOPES = {
  alerts: path => path.startsWith('incidents/'),
  watchlist: path => path.startsWith('watchlist/') || path.startsWith('incidents/'),
  resources: (path, data, uid) => path.startsWith(`resources/${uid}_`),
  direct_messages: (path, data) => isNonEmptyString(data.conversationId) &&
    !data.conversationId.includes('/') && path.startsWith(`direct_messages/${data.conversationId}/`),
};

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class HttpError extends Error {
  constructor(status, body) {
    super(typeof body.error === 'string' ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// Builds the onRequest handler. Dependencies:
//   db       admin Firestore
//   auth     { verifyIdToken(token), deleteUser(uid) }
//   storage  { bucketName, deleteFile(path) (ignores not-found), listFiles(prefix) -> [path] }
//   logger   console-like
//   now      () => ms, for tests
function createDeleteAccountHandler({ db, auth, storage, logger = console, now = () => Date.now() }) {
  const bucketName = storage && storage.bucketName;

  const log = (uid, step, fields = {}) => {
    const extra = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
    logger.log(`[deleteAccount] uid=${uid} step=${step}${extra ? ` ${extra}` : ''}`);
  };

  async function deleteFiles(paths) {
    const unique = [...new Set(paths)];
    for (let i = 0; i < unique.length; i += FILE_DELETE_CONCURRENCY) {
      await Promise.all(unique.slice(i, i + FILE_DELETE_CONCURRENCY).map(path => storage.deleteFile(path)));
    }
    return unique.length;
  }

  // Deletes every doc the query finds, page by page: first each page's photos (the paths
  // photosOf(docsData) picks, when given), then the docs in one batch. Returns
  // { docs, files }.
  async function deleteQuery(query, photosOf = null) {
    let docs = 0;
    let files = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const snap = await query.limit(PAGE_SIZE).get();
      if (snap.empty) break;
      if (photosOf) {
        files += await deleteFiles(await photosOf(snap.docs.map(d => d.data() || {})));
      }
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      docs += snap.docs.length;
      if (snap.docs.length < PAGE_SIZE) break;
    }
    return { docs, files };
  }

  async function deleteUnderPrefix(prefix, keep = () => true) {
    const paths = (await storage.listFiles(prefix)).filter(p => typeof p === 'string' && keep(p));
    return deleteFiles(paths);
  }

  // Every conversation the user takes part in, with all of its messages and photos. The
  // conversation doc goes last, so a retry still finds it.
  async function deleteConversations(uid, photosOf) {
    let conversations = 0;
    let messages = 0;
    let files = 0;
    const convQuery = db.collection('conversations').where('participants', 'array-contains', uid);
    for (let page = 0; page < MAX_PAGES; page++) {
      const snap = await convQuery.limit(CONVERSATION_PAGE_SIZE).get();
      if (snap.empty) break;
      for (const conv of snap.docs) {
        const result = await deleteQuery(db.collection('direct_messages').where('conversationId', '==', conv.id), photosOf);
        messages += result.docs;
        files += result.files;
        files += await deleteUnderPrefix(`direct_messages/${conv.id}/`);
        await conv.ref.delete();
        conversations++;
      }
      if (snap.docs.length < CONVERSATION_PAGE_SIZE) break;
    }
    return { conversations, messages, files };
  }

  // The members of orgId (both field spellings, deduplicated, and only profiles whose
  // canonical org really is orgId), the caller excluded.
  async function otherMembersOf(orgId, uid) {
    const [snake, camel] = await Promise.all([
      db.collection('users').where('organization_id', '==', orgId).get(),
      db.collection('users').where('organizationId', '==', orgId).get(),
    ]);
    const byId = new Map();
    for (const d of [...snake.docs, ...camel.docs]) {
      if (d.id === uid || byId.has(d.id)) continue;
      const data = d.data() || {};
      if (profileOrgId(data) !== orgId) continue;
      byId.set(d.id, data);
    }
    return [...byId.entries()].map(([memberUid, data]) => ({ uid: memberUid, data }));
  }

  async function orgNameFor(orgId) {
    const byField = await db.collection('organizations').where('id', '==', orgId).limit(1).get();
    let data = byField.empty ? null : byField.docs[0].data();
    if (!data) {
      const direct = await db.collection('organizations').doc(orgId).get();
      data = direct.exists ? direct.data() : null;
    }
    return data && typeof data.name === 'string' ? data.name : '';
  }

  function memberSummary({ uid, data }) {
    const name = isNonEmptyString(data.name) && data.name.trim()
      ? data.name.trim()
      : (isNonEmptyString(data.email) ? data.email : '');
    return { uid, name, role: typeof data.role === 'string' ? data.role : '' };
  }

  // An admin may only leave an org that keeps an admin. Throws an HttpError (409 / 400)
  // or returns after any needed handoff.
  async function ensureOrgKeepsAnAdmin(uid, profile, newAdminUid) {
    if (!profile || !isAdminRole(profile.role)) return;
    const orgId = profileOrgId(profile);
    if (!orgId) return;

    const others = await otherMembersOf(orgId, uid);
    if (others.length === 0 || others.some(m => isAdminRole(m.data.role))) return;

    if (newAdminUid === undefined || newAdminUid === null) {
      const members = others.map(memberSummary)
        .sort((a, b) => a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
      log(uid, 'last-admin', { org: orgId, members: members.length });
      throw new HttpError(409, { error: 'last-admin', organizationName: await orgNameFor(orgId), members });
    }
    if (!isNonEmptyString(newAdminUid) || !others.some(m => m.uid === newAdminUid)) {
      log(uid, 'invalid-new-admin', { org: orgId });
      throw new HttpError(400, { error: 'invalid-new-admin' });
    }

    // Re-check membership inside the transaction: the member may have been removed or
    // moved since the query.
    const candidateRef = db.collection('users').doc(newAdminUid);
    const promoted = await db.runTransaction(async (tx) => {
      const snap = await tx.get(candidateRef);
      if (!snap.exists || profileOrgId(snap.data()) !== orgId) return false;
      tx.update(candidateRef, { role: 'admin' });
      return true;
    });
    if (!promoted) {
      log(uid, 'invalid-new-admin', { org: orgId });
      throw new HttpError(400, { error: 'invalid-new-admin' });
    }
    log(uid, 'handoff', { org: orgId, newAdmin: newAdminUid });
  }

  async function deleteEverything(uid) {
    // incidents/ and watchlist/ paths carry no owner, and every member of an org can read
    // its alerts' and watchlist entries' photo URLs. A photo that a doc of another user in
    // the org still shows stays. Loaded once per org, and only when needed.
    const shownByOthers = new Map();
    const pathsShownByOthers = (orgId) => {
      if (!shownByOthers.has(orgId)) {
        shownByOthers.set(orgId, (async () => {
          const [alerts, watchlist] = await Promise.all([
            db.collection('alerts').where('organizationId', '==', orgId).get(),
            db.collection('watchlist').where('organizationId', '==', orgId).get(),
          ]);
          const shown = new Set();
          for (const [snap, authorField] of [[alerts, 'reporterId'], [watchlist, 'createdBy']]) {
            for (const d of snap.docs) {
              const data = d.data() || {};
              if (data[authorField] === uid) continue;
              imagePathsOf(data, bucketName).forEach(p => shown.add(p));
            }
          }
          return shown;
        })());
      }
      return shownByOthers.get(orgId);
    };
    const keptPaths = new Set();

    // The photos of a page of `collection` docs that may be deleted with them.
    const photosOf = collection => async (docsData) => {
      const inScope = PHOTO_SCOPES[collection];
      const paths = [];
      for (const data of docsData) {
        const own = imagePathsOf(data, bucketName).filter(p => inScope(p, data, uid));
        if (own.length && (collection === 'alerts' || collection === 'watchlist') &&
            isNonEmptyString(data.organizationId)) {
          const shown = await pathsShownByOthers(data.organizationId);
          for (const p of own) {
            if (shown.has(p)) keptPaths.add(p);
            else paths.push(p);
          }
        } else {
          paths.push(...own);
        }
      }
      return paths;
    };

    const steps = [
      ['alerts', () => deleteQuery(db.collection('alerts').where('reporterId', '==', uid), photosOf('alerts'))],
      ['watchlist', () => deleteQuery(db.collection('watchlist').where('createdBy', '==', uid), photosOf('watchlist'))],
      ['resources', () => deleteQuery(db.collection('resources').where('postedBy', '==', uid), photosOf('resources'))],
      ['resource_uploads', async () => {
        // Uploads whose post was never saved, or was deleted without its photo.
        const pattern = new RegExp(`^resources/${escapeRegExp(uid)}_\\d+\\.jpg$`);
        return { files: await deleteUnderPrefix(`resources/${uid}_`, p => pattern.test(p)) };
      }],
      ['team_messages', () => deleteQuery(db.collection('team_messages').where('senderId', '==', uid))],
      ['conversations', () => deleteConversations(uid, photosOf('direct_messages'))],
      ['direct_messages', () => deleteQuery(db.collection('direct_messages').where('senderId', '==', uid), photosOf('direct_messages'))],
      ['dm_invites_sent', () => deleteQuery(db.collection('dm_invites').where('fromUserId', '==', uid))],
      ['dm_invites_received', () => deleteQuery(db.collection('dm_invites').where('toUserId', '==', uid))],
      ['invite_codes', () => deleteQuery(db.collection('invite_codes').where('createdBy', '==', uid))],
    ];
    for (const [step, run] of steps) {
      let result;
      try {
        result = await run();
      } catch (error) {
        error.deleteStep = step;
        throw error;
      }
      log(uid, step, result);
    }
    if (keptPaths.size) log(uid, 'photos_kept', { files: keptPaths.size });

    try {
      await db.collection('users').doc(uid).delete();
    } catch (error) {
      error.deleteStep = 'profile';
      throw error;
    }
    log(uid, 'profile');

    try {
      await auth.deleteUser(uid);
      log(uid, 'auth_user');
    } catch (error) {
      // A retry after the Auth user is already gone (its ID token stays valid for up to
      // an hour) has nothing left to do.
      if (error && (error.code === 'auth/user-not-found' || error.errorInfo?.code === 'auth/user-not-found')) {
        log(uid, 'auth_user', { already: 'deleted' });
      } else {
        error.deleteStep = 'auth_user';
        throw error;
      }
    }
  }

  return async (req, res) => {
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

    const authHeader = (req.headers && req.headers.authorization) || '';
    if (!authHeader.startsWith('Bearer ') || authHeader.length <= 'Bearer '.length) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    let decoded;
    try {
      decoded = await auth.verifyIdToken(authHeader.slice('Bearer '.length));
    } catch (error) {
      logger.warn(`[deleteAccount] ID token rejected: ${error && error.code ? error.code : 'invalid'}`);
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const uid = decoded && decoded.uid;
    if (!isNonEmptyString(uid)) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const authTimeMs = Number(decoded.auth_time) * 1000;
    if (!Number.isFinite(authTimeMs) || authTimeMs <= 0 || now() - authTimeMs > RECENT_LOGIN_MS) {
      log(uid, 'requires-recent-login');
      res.status(403).json({ error: 'requires-recent-login' });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const newAdminUid = body.newAdminUid;

    let step = 'start';
    try {
      log(uid, 'start', { handoff: newAdminUid === undefined || newAdminUid === null ? 'no' : 'yes' });
      step = 'profile_read';
      const profileSnap = await db.collection('users').doc(uid).get();
      const profile = profileSnap.exists ? (profileSnap.data() || {}) : null;

      step = 'admin_check';
      await ensureOrgKeepsAnAdmin(uid, profile, newAdminUid);

      step = 'delete';
      await deleteEverything(uid);

      log(uid, 'done');
      res.status(200).json({ deleted: true });
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json(error.body);
        return;
      }
      const failedStep = (error && error.deleteStep) || step;
      logger.error(`[deleteAccount] uid=${uid} step=${failedStep} failed: ${error && error.code ? error.code : ''} ${error && error.message ? error.message : error}`);
      res.status(500).json({ error: 'internal' });
    }
  };
}

module.exports = {
  RECENT_LOGIN_MS,
  PAGE_SIZE,
  STORAGE_PREFIXES,
  profileOrgId,
  storagePathFromUrl,
  imagePathsOf,
  createDeleteAccountHandler,
};
