/**
 * Seed the App Review account's org with sample team channels, team messages and
 * watchlist entries, so the Team and Watchlist tabs aren't empty during App Review
 * (an empty "No channels available" screen reads as an unfinished app, Guideline 2.1).
 *
 * Everything written is fictional sample content with no photos, and every document id
 * starts with 'reviewdemo_', so a re-run skips what already exists and --remove deletes
 * exactly what this script created. Nothing else is changed.
 *
 * Safety:
 * - Acts only on the org of the profile with the given email, AND that org's document id
 *   must equal --org (every org is grandfathered and solo-admin customer orgs exist, so
 *   nothing else tells the review org apart). It also refuses unless the profile is the
 *   org's only member, or the org is pending/rejected.
 * - Never touches a 'reviewdemo_' doc that belongs to another org.
 * - Dry run by default: prints what it would write.
 * - --remove works even after the review account was deleted (it then uses --org alone),
 *   and keeps #general if anyone other than the seed posted in it.
 *
 * Talks to the Firestore REST API directly (Node 18+, no npm install needed).
 *
 * Usage:
 *   GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>) \
 *   node scripts/seed-reviewer-demo.js <review-account-email> --org <org-doc-id> [--apply | --remove [--apply]]
 *
 * The Team tab loads its channel when the app opens, so relaunch the app afterwards.
 */
const PROJECT = 'holyguard-app';
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST; // host:port, for testing against a local emulator
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const BASE = `${EMULATOR ? `http://${EMULATOR}` : 'https://firestore.googleapis.com'}/v1/${ROOT}`;
const COMMIT_URL = `${EMULATOR ? `http://${EMULATOR}` : 'https://firestore.googleapis.com'}/v1/projects/${PROJECT}/databases/(default)/documents:commit`;
const TOKEN = EMULATOR ? 'owner' : (process.env.GCLOUD_ACCESS_TOKEN || '').trim();
const PREFIX = 'reviewdemo_';
const USAGE = 'Usage: node scripts/seed-reviewer-demo.js <review-account-email> --org <org-doc-id> [--apply | --remove [--apply]]';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

let APPLY = false;
let REMOVE = false;
let EMAIL = null;
let ORG_DOC = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--org') {
    ORG_DOC = (argv[++i] || '').trim();
    if (!ORG_DOC || ORG_DOC.startsWith('--') || ORG_DOC.includes('/')) fail(`--org needs the org's document id.\n${USAGE}`);
  } else if (arg === '--apply') APPLY = true;
  else if (arg === '--remove') REMOVE = true;
  else if (arg.startsWith('--')) fail(`Unknown option: ${arg}\n${USAGE}`);
  else if (EMAIL === null) EMAIL = arg.trim();
  else fail(`Only one email, please.\n${USAGE}`);
}
if (!EMAIL || !EMAIL.includes('@')) fail(USAGE);
if (!ORG_DOC) fail(`--org <org-doc-id> is required.\n${USAGE}`);
if (!TOKEN) fail('Set GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>)');

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Goog-User-Project': PROJECT,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`${method} ${url.split('?')[0].replace(BASE, '')} -> HTTP ${res.status}: ${text.slice(0, 500)}`),
      { status: res.status });
  }
  return text ? JSON.parse(text) : {};
}

function val(v) {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  return '<complex>';
}
const plain = d => ({
  name: d.name,
  id: d.name.split('/').pop(),
  f: Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)])),
});

async function where(collectionId, field, value, limit = 50) {
  const rows = await call('POST', `${BASE}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId }],
      where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value } },
      limit,
    },
  });
  return rows.filter(r => r.document).map(r => plain(r.document));
}

async function getDoc(path) {
  try {
    return plain(await call('GET', `${BASE}/${path}`));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// The org a profile belongs to, read the way the rules and functions read it:
// organization_id wins whenever present; '' or 'removed' means no org.
function profileOrgId(f) {
  const o = 'organization_id' in f ? f.organization_id : f.organizationId;
  return typeof o === 'string' && o !== '' && o !== 'removed' ? o : null;
}

// Firestore REST value encoding for the plain values used below.
function enc(v) {
  if (v === null) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map(enc) } : {} };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}
const fields = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)]));

function sampleDocs({ uid, reviewerName, orgId, defaultChannelId, hasWatchlistChannel = false, now }) {
  const ago = mins => new Date(now - mins * 60000);
  const docs = [];

  // Channels. #general is the default the Team tab opens; it is only created when the
  // org has no default channel yet (otherwise the messages go into the existing one).
  const generalId = defaultChannelId || `${PREFIX}general`;
  if (!defaultChannelId) {
    docs.push({ collection: 'channels', id: generalId, data: {
      name: 'general', organizationId: orgId, createdBy: uid, createdAt: ago(4 * 1440), isDefault: true } });
  }
  docs.push({ collection: 'channels', id: `${PREFIX}security_team`, data: {
    name: 'security-team', organizationId: orgId, createdBy: uid, createdAt: ago(4 * 1440 - 5), isDefault: false } });
  // 'Add to watchlist' on a Home alert posts to a channel named exactly 'watchlist'.
  if (!hasWatchlistChannel) {
    docs.push({ collection: 'channels', id: `${PREFIX}watchlist`, data: {
      name: 'watchlist', organizationId: orgId, createdBy: uid, createdAt: ago(4 * 1440 - 10), isDefault: false } });
  }

  // Team messages in #general (fictional team members; the sender ids match no account).
  const people = {
    lead: { senderId: `${PREFIX}lead`, senderName: 'Sarah M.', senderRole: 'admin' },
    david: { senderId: `${PREFIX}david`, senderName: 'David R.', senderRole: 'security' },
    mike: { senderId: `${PREFIX}mike`, senderName: 'Mike T.', senderRole: 'security' },
    jenna: { senderId: `${PREFIX}jenna`, senderName: 'Jenna K.', senderRole: 'member' },
  };
  const messages = [
    ['lead', 185, 'Hi team. Doors open in 30 minutes. Greeters at the main entrance, two on the north lot.'],
    ['david', 182, "Copy. I'll take the north lot and the side entrance by the gym."],
    ['lead', 176, 'Radio check on channel 3 in 10 minutes, please.'],
    ['jenna', 150, "Kids' wing check-in is staffed. All exterior doors locked except main."],
    ['mike', 95, "The dark sedan from last Sunday hasn't been back. I'll keep an eye on row C."],
    ['lead', 40, 'Thanks, all. Short debrief in the lobby after the second service.'],
  ];
  messages.forEach(([who, mins, text], i) => {
    docs.push({ collection: 'team_messages', id: `${PREFIX}msg_${i + 1}`, data: {
      text, ...people[who], organizationId: orgId, channelId: generalId, timestamp: ago(mins) } });
  });

  // Watchlist entries: no photos, no real people or real plates.
  const watch = [
    { id: 'watch_1', mins: 2 * 1440, data: {
      name: 'Person photographing exits', licensePlate: null,
      physicalDescription: 'Gray hoodie and black backpack.',
      status: 'monitoring', location: 'North parking lot',
      notes: 'Walked the perimeter twice and took photos of the exits, then left without coming in. If seen again, greet them and let the team lead know.' } },
    { id: 'watch_2', mins: 6 * 1440, data: {
      name: 'Dark gray sedan', licensePlate: 'Not captured',
      physicalDescription: 'Four-door sedan, tinted windows, dent on the rear bumper.',
      status: 'active', location: 'North lot, row C',
      notes: 'Seen idling in row C during last Sunday\'s service. Note the plate if it returns.' } },
    { id: 'watch_3', mins: 12 * 1440, data: {
      name: 'White cargo van', licensePlate: null,
      physicalDescription: 'Unmarked white cargo van at the loading dock after hours.',
      status: 'resolved', location: 'Loading dock',
      notes: 'Confirmed as a contractor delivery. No further action.' } },
  ];
  for (const w of watch) {
    docs.push({ collection: 'watchlist', id: `${PREFIX}${w.id}`, data: {
      ...w.data, imageUrls: [], organizationId: orgId, createdBy: uid, createdByName: reviewerName,
      linkedAlertId: null, createdAt: ago(w.mins) } });
  }
  return docs;
}

(async () => {
  console.log(`${EMULATOR ? `[EMULATOR ${EMULATOR}] ` : ''}${REMOVE ? 'REMOVE' : 'SEED'} ${APPLY ? '(APPLY)' : '(dry run)'}`);

  // 1. The review account and its org. The org's document id must equal --org.
  let profiles = await where('users', 'email', { stringValue: EMAIL }, 5);
  if (profiles.length === 0 && EMAIL !== EMAIL.toLowerCase()) {
    profiles = await where('users', 'email', { stringValue: EMAIL.toLowerCase() }, 5);
  }
  if (profiles.length > 1) fail(`Expected exactly one profile with that email, found ${profiles.length}. Nothing written.`);
  let me = null;
  let orgId = null;
  let org = null;
  if (profiles.length === 1) {
    me = profiles[0];
    orgId = profileOrgId(me.f);
    if (!orgId) fail(`That profile has no org (organization_id ${JSON.stringify(me.f.organization_id)}). Nothing written.`);
    console.log(`Profile: users/${me.id}  name=${JSON.stringify(me.f.name)} role=${me.f.role} org=${orgId}`);
    let orgs = await where('organizations', 'id', { stringValue: orgId }, 5);
    if (orgs.length === 0) {
      const byDoc = orgId.includes('/') ? null : await getDoc(`organizations/${orgId}`);
      if (byDoc && !('id' in byDoc.f)) orgs = [byDoc];
    }
    if (orgs.length !== 1) fail(`Expected exactly one org for ${orgId}, found ${orgs.length}. Nothing written.`);
    org = orgs[0];
  } else {
    // No profile. Only --remove may go on: App Review may have deleted the review account.
    if (!REMOVE) fail('Expected exactly one profile with that email, found 0. Nothing written.');
    org = await getDoc(`organizations/${ORG_DOC}`);
    if (!org) fail(`No organizations/${ORG_DOC}. Nothing deleted.`);
    orgId = typeof org.f.id === 'string' && org.f.id ? org.f.id : org.id;
    console.log('No profile with that email (was the account deleted?). Using --org for the removal.');
  }
  if (org.id !== ORG_DOC) {
    fail(`The account's org is organizations/${org.id}, not --org ${ORG_DOC}, so this is not the review org. Nothing written.`);
  }
  console.log(`Org: organizations/${org.id}  name=${JSON.stringify(org.f.name)} status=${org.f.status} grandfathered=${org.f.grandfathered}`);

  if (REMOVE) {
    // Delete every doc this script can create, wherever it exists, but only in this org.
    const all = sampleDocs({ uid: me ? me.id : '', reviewerName: '', orgId, defaultChannelId: null, now: Date.now() });
    let present = [];
    for (const d of all) {
      const cur = await getDoc(`${d.collection}/${d.id}`);
      if (cur) {
        if (cur.f.organizationId !== orgId) fail(`${d.collection}/${d.id} belongs to another org. Nothing deleted.`);
        present.push(d);
      }
    }
    // Keep #general if anyone other than the seed posted in it, so those messages keep a channel.
    const generalId = `${PREFIX}general`;
    if (present.some(d => d.id === generalId)) {
      const inGeneral = await where('team_messages', 'channelId', { stringValue: generalId }, 200);
      const real = inGeneral.filter(m => !m.id.startsWith(PREFIX) && m.f.organizationId === orgId);
      if (real.length > 0) {
        console.log(`Keeping channels/${generalId}: ${real.length} message(s) in it were not written by this script.`);
        present = present.filter(d => d.id !== generalId);
      }
    }
    console.log(`${present.length} sample doc(s) to delete:`);
    present.forEach(d => console.log(`  - ${d.collection}/${d.id}`));
    if (!APPLY || present.length === 0) {
      console.log(APPLY ? 'Nothing to delete.' : 'Dry run: nothing deleted. Add --apply to delete.');
      return;
    }
    await call('POST', COMMIT_URL, { writes: present.map(d => ({ delete: `${ROOT}/${d.collection}/${d.id}` })) });
    console.log(`Deleted ${present.length} doc(s).`);
    return;
  }

  if (['pending', 'rejected'].includes(org.f.status)) fail('The org is pending or rejected. Nothing written.');
  if (org.f.grandfathered !== true) fail('The org is not grandfathered, so the review account would land on the paywall. Nothing written.');

  // 2. The account must be the org's only member.
  const members = new Map();
  for (const field of ['organization_id', 'organizationId']) {
    for (const p of await where('users', field, { stringValue: orgId }, 20)) {
      if (profileOrgId(p.f) === orgId) members.set(p.id, p);
    }
  }
  const others = [...members.keys()].filter(id => id !== me.id);
  if (others.length > 0) {
    fail(`The org has ${others.length} other member(s), so it is not the review org. Nothing written.`);
  }

  // 3. Reuse an existing default channel (never make a second default) and an existing
  //    'watchlist' channel.
  const channels = await where('channels', 'organizationId', { stringValue: orgId }, 50);
  const existingDefault = channels.find(c => c.f.isDefault === true && !c.id.startsWith(PREFIX));
  const hasWatchlistChannel = channels.some(c => c.f.name === 'watchlist' && !c.id.startsWith(PREFIX));
  const docs = sampleDocs({
    uid: me.id,
    reviewerName: me.f.name || 'Team Lead',
    orgId,
    defaultChannelId: existingDefault ? existingDefault.id : null,
    hasWatchlistChannel,
    now: Date.now(),
  });

  const toWrite = [];
  for (const d of docs) {
    const cur = await getDoc(`${d.collection}/${d.id}`);
    if (cur) {
      if (cur.f.organizationId !== orgId) fail(`${d.collection}/${d.id} belongs to another org. Nothing written.`);
      console.log(`  skip (exists) ${d.collection}/${d.id}`);
    } else {
      toWrite.push(d);
    }
  }
  console.log(existingDefault
    ? `Using the existing default channel ${existingDefault.id} (#${existingDefault.f.name}).`
    : 'No default channel yet: creating #general as the default.');
  console.log(`${toWrite.length} doc(s) to create:`);
  for (const d of toWrite) {
    const label = d.data.name || d.data.text || '';
    console.log(`  + ${d.collection}/${d.id}  ${JSON.stringify(label).slice(0, 80)}`);
  }
  if (!APPLY || toWrite.length === 0) {
    console.log(APPLY ? 'Nothing to create.' : 'Dry run: nothing written. Add --apply to write.');
    return;
  }

  // One atomic commit; each create fails if the doc appeared in the meantime.
  await call('POST', COMMIT_URL, {
    writes: toWrite.map(d => ({
      update: { name: `${ROOT}/${d.collection}/${d.id}`, fields: fields(d.data) },
      currentDocument: { exists: false },
    })),
  });
  console.log(`Created ${toWrite.length} doc(s). Watchlist updates live; relaunch the app (or sign out and in) to see the Team channel.`);
})().catch(e => fail(`Failed: ${e.message}. Nothing was written if this happened before "Created".`));
