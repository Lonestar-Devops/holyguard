/**
 * Org profile changes: lists what the recordOrgProfileChange trigger records whenever an
 * org's name, address or map pin changes (old and new values, who made the change, when),
 * and marks a change reviewed once it has been checked.
 *
 * A change waits for review unless a super admin made it or the org is pending (already in
 * Admin Review) or rejected. A verified org keeps its Verified badge on everyone's map after
 * its admin edits it, so check that the new name and place still belong to that org.
 *
 * Listing only reads (one POST .../documents:runQuery over org_profile_changes).
 * --mark-reviewed is a dry run unless --apply is given; it then sets reviewedAt, reviewedBy
 * and reviewNote on that one record, and only if the record hasn't changed since it was read.
 *
 * Usage (Node 18+, no npm install needed):
 *   GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>) \
 *   node scripts/org-profile-changes.js [--all] [--org <orgDocId>]
 *
 *     (no flags)        changes waiting for review, newest first
 *     --all             every recorded change, newest first
 *     --org <orgDocId>  only that org's changes (with either of the above)
 *
 *   node scripts/org-profile-changes.js --mark-reviewed <recordId> [--note "text"] [--apply]
 */
const PROJECT = 'holyguard-app';
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const COLLECTION = 'org_profile_changes'; // written by recordOrgProfileChange (functions/orgProfileChanges.js)
const REVIEWED_BY = 'scripts/org-profile-changes.js';
const REVIEW_FIELDS = ['reviewedAt', 'reviewedBy', 'reviewNote'];
const USAGE = [
  'Usage:',
  '  node scripts/org-profile-changes.js [--all] [--org <orgDocId>]',
  '  node scripts/org-profile-changes.js --mark-reviewed <recordId> [--note "text"] [--apply]',
].join('\n');

// Bad input, or a write the script won't make: printed as is, and the run exits with code 1.
class Refusal extends Error {}

// Org names, addresses and profile names are typed by users, so characters a terminal
// may act on (control codes, bidi overrides, line separators) are printed escaped.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const safe = s => String(s).replace(UNSAFE, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
const quote = s => safe(JSON.stringify(s));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const own = (map, key) => (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);

// A usable Firestore document id (the same test the trigger applies to authId).
function isDocId(s) {
  return typeof s === 'string' && s.length > 0 && Buffer.byteLength(s, 'utf8') <= 1500
    && !s.includes('/') && s !== '.' && s !== '..' && !/^__.*__$/.test(s);
}

// Only these arguments are accepted, so a typo can't quietly change what runs.
function parseArgs(argv) {
  const opts = { all: false, org: null, recordId: null, note: null, apply: false, help: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Refusal(`${flag} is given more than once.\n${USAGE}`);
    seen.add(flag);
    if (flag === '--all') opts.all = true;
    else if (flag === '--apply') opts.apply = true;
    else if (flag === '--help' || flag === '-h') opts.help = true;
    else if (flag === '--org' || flag === '--mark-reviewed' || flag === '--note') {
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith('--') ? argv[++i].trim() : '';
      if (!value) {
        const hint = flag === '--note' && next !== undefined && next.startsWith('--') ? " (a note can't start with --)" : '';
        throw new Refusal(`${flag} needs a value${hint}.\n${USAGE}`);
      }
      if (flag === '--org') opts.org = value;
      else if (flag === '--note') opts.note = value;
      else opts.recordId = value;
    } else throw new Refusal(`Unknown argument: ${flag}\n${USAGE}`);
  }
  if (opts.help) return opts;
  if (opts.recordId === null && (opts.note !== null || opts.apply)) {
    throw new Refusal(`--note and --apply only go with --mark-reviewed.\n${USAGE}`);
  }
  if (opts.recordId !== null && (opts.all || opts.org !== null)) {
    throw new Refusal(`--all and --org are for listing; leave them out with --mark-reviewed.\n${USAGE}`);
  }
  if (opts.recordId !== null && !isDocId(opts.recordId)) throw new Refusal(`Not a valid record id: ${quote(opts.recordId)}`);
  return opts;
}

// Firestore REST value -> plain JS. Timestamps become Dates; NaN and +/-Infinity doubles
// arrive as strings; an empty map or array arrives without its fields or values.
function decodeValue(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  return v; // a type the records don't use: shown raw rather than dropped
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, decodeValue(v)]));
}

// A change record: its decoded fields, its doc ID, and its update time kept as the exact
// string Firestore returned (the write precondition must match it to the microsecond).
function decodeDoc(doc) {
  return { ...decodeFields(doc.fields), recordId: doc.name.split('/').pop(), updateTime: doc.updateTime };
}

const waitingForReview = c => c.needsReview === true && c.reviewedAt == null;

function selectChanges(changes, { all = false, org = null } = {}) {
  return changes.filter(c => (all || waitingForReview(c)) && (!org || c.orgDocId === org));
}

// When the change happened: the org doc's update time, else when it was recorded.
function changeTime(c) {
  return [c.changedAt, c.recordedAt].find(d => d instanceof Date && !Number.isNaN(d.getTime())) || null;
}

function sortNewestFirst(changes) {
  const ms = c => (changeTime(c) ? changeTime(c).getTime() : -Infinity);
  const byId = (a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);
  return [...changes].sort((a, b) => ms(b) - ms(a) || byId(a, b));
}

// A field value: strings quoted, absent (missing or null) as (none).
function formatValue(v) {
  if (v === null || v === undefined) return '(none)';
  if (typeof v === 'string') return quote(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '(invalid time)' : v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return safe(JSON.stringify(v));
}

// Local time, then UTC.
function formatWhen(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '(time unknown)';
  const local = d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'long' });
  return `${local} (${d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} UTC)`;
}

// Who made the change: their profile when the trigger found one, else what the event said.
function formatActor(c) {
  const by = c.changedBy && typeof c.changedBy === 'object' ? c.changedBy : {};
  const text = v => (typeof v === 'string' && v ? safe(v) : '');
  if (!text(by.uid)) return `unidentified (authType ${text(by.authType) || '(none)'}, authId ${text(by.authId) || '(none)'})`;
  // Their own org, when it isn't the one they changed (a super admin, or a profile moved since)
  const sameOrg = text(by.orgId) && (by.orgId === c.orgDocId || by.orgId === c.orgIdField);
  const org = sameOrg ? '' : text(by.orgId) ? ` of ${text(by.orgId)}` : ', no org';
  return `${text(by.name) || '(no name)'} <${text(by.email) || 'no email'}> (${text(by.role) || 'no role'}${org}, uid ${text(by.uid)})`;
}

// The org's status, and whether everyone's map shows it with the Verified badge (the map
// counts a missing or empty status as 'Active').
function formatStatus(status) {
  const text = status == null ? '(none)' : status === '' ? '(empty)' : safe(status);
  const shown = status || 'Active';
  return shown === 'verified' || shown === 'Active' ? `${text}, has the Verified badge` : text;
}

function formatReview(c) {
  if (c.reviewedAt != null) {
    const by = typeof c.reviewedBy === 'string' && c.reviewedBy ? ` by ${safe(c.reviewedBy)}` : '';
    const note = typeof c.reviewNote === 'string' && c.reviewNote ? `, note ${quote(c.reviewNote)}` : '';
    return `reviewed ${formatWhen(c.reviewedAt)}${by}${note}`;
  }
  return c.needsReview === true ? 'NEEDS REVIEW' : 'not flagged';
}

function formatChange(c) {
  const row = (label, text) => `  ${label.padEnd(10)}${text}`;
  const idField = typeof c.orgIdField === 'string' && c.orgIdField && c.orgIdField !== c.orgDocId ? `, id field ${safe(c.orgIdField)}` : '';
  const changed = Array.isArray(c.changedFields) && c.changedFields.length
    ? c.changedFields.map(f => `${safe(f)}: ${formatValue(own(c.before, f))} -> ${formatValue(own(c.after, f))}`)
    : ['(no field list recorded)'];
  if (typeof c.pinMovedMiles === 'number' && Number.isFinite(c.pinMovedMiles)) {
    changed.push(`pin moved ${c.pinMovedMiles === 0 ? 'less than 0.01' : c.pinMovedMiles} mi`);
  }
  return [
    formatWhen(changeTime(c)),
    row('Org:', `${formatValue(c.orgName)} (doc ${safe(c.orgDocId ?? '?')}${idField}), status ${formatStatus(c.orgStatus)}`),
    row('Review:', formatReview(c)),
    ...changed.map((line, i) => row(i ? '' : 'Changed:', line)),
    row('By:', formatActor(c)),
    row('Record:', safe(c.recordId)),
  ].join('\n');
}

function formatListing(changes, { all = false, org = null } = {}) {
  const scope = org ? ` for org ${safe(org)}` : '';
  const recorded = selectChanges(changes, { all: true, org });
  const waiting = selectChanges(changes, { org });
  const shown = sortNewestFirst(all ? recorded : waiting);
  if (!recorded.length) return `No org profile changes recorded${scope}.`;
  if (!shown.length) return `Nothing waiting for review${scope} (${plural(recorded.length, 'change')} recorded; --all lists them).`;
  return [
    `${all ? 'Recorded changes' : 'Changes waiting for review'}${scope}, newest first:`,
    '',
    shown.map(formatChange).join('\n\n'),
    '',
    all ? `${plural(recorded.length, 'change')} recorded${scope}, ${waiting.length} waiting for review.`
      : `${plural(waiting.length, 'change')} waiting for review${scope} (${recorded.length} recorded in all).`,
    ...(waiting.length ? ['Mark one reviewed: node scripts/org-profile-changes.js --mark-reviewed <record> [--note "text"] [--apply]'] : []),
  ].join('\n');
}

const recordUrl = recordId => `${FIRESTORE}/${COLLECTION}/${encodeURIComponent(recordId)}`;

// The one write --apply makes: exactly the review fields, and only if the record still has
// the update time it was read with, so a concurrent change fails it instead of being overwritten.
function reviewRequest(recordId, updateTime, now, note) {
  const mask = REVIEW_FIELDS.map(f => `updateMask.fieldPaths=${f}`).join('&');
  return {
    url: `${recordUrl(recordId)}?${mask}&currentDocument.updateTime=${encodeURIComponent(updateTime)}`,
    body: {
      fields: {
        reviewedAt: { timestampValue: now.toISOString() },
        reviewedBy: { stringValue: REVIEWED_BY },
        reviewNote: note === null ? { nullValue: null } : { stringValue: note },
      },
    },
  };
}

function restApi(token) {
  return async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Goog-User-Project': PROJECT },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`${method} ${url.split('?')[0]} -> HTTP ${res.status}: ${text.slice(0, 500)}`), { status: res.status });
    return text ? JSON.parse(text) : {};
  };
}

async function getChange(api, recordId) {
  try {
    return decodeDoc(await api('GET', recordUrl(recordId)));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function markReviewed(api, { recordId, note, apply }) {
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (pass --apply to write)'}\n`);
  const change = await getChange(api, recordId);
  if (!change) throw new Refusal(`No change record ${quote(recordId)} in ${COLLECTION}. Nothing was written.`);
  console.log(formatChange(change));
  if (change.reviewedAt != null) throw new Refusal(`\nAlready ${formatReview(change)}. Nothing was written.`);
  if (typeof change.updateTime !== 'string' || !change.updateTime) {
    throw new Refusal('\nThe record came back without an update time, so it cannot be guarded against a concurrent change. Nothing was written.');
  }

  const { url, body } = reviewRequest(recordId, change.updateTime, new Date(), note);
  console.log(`\n${apply ? 'Writing' : 'Would write'} (only if the record's update time is still ${change.updateTime}):`);
  for (const f of REVIEW_FIELDS) {
    const v = decodeValue(body.fields[f]);
    console.log(`  ${`${f}:`.padEnd(12)}${v === null ? 'null' : formatValue(v)}`);
  }
  if (!apply) {
    console.log('\nDry run only — re-run with --apply to write.');
    return;
  }

  let written = null;
  try {
    written = await api('PATCH', url, body);
  } catch (e) {
    if (e.status >= 400 && e.status < 500) {
      const why = e.status === 401 || e.status === 403 ? 'the token was refused (expired, or not the project owner)'
        : 'the record changed or was deleted since it was read, or the request was refused';
      throw new Refusal(`\nNothing was written: ${why}.\n${e.message}`);
    }
    // A timeout, a 5xx or a dropped connection can arrive after the write went through.
    console.error(`\nThe write did not answer cleanly (${e.message}). Reading the record back...`);
  }
  let after;
  try {
    after = await getChange(api, recordId);
  } catch (e) {
    // The write answered OK, so it is done; only the confirming read failed.
    if (!written) throw e;
    console.log(`\nMarked reviewed (the write answered OK), but reading it back failed: ${e.message}`);
    if (written.name) console.log(formatChange(decodeDoc(written)));
    return;
  }
  if (!after || after.reviewedAt == null) throw new Refusal('\nRead back: the record is NOT marked reviewed.');
  console.log(`\nRead back:\n${formatChange(after)}`);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const token = (env.GCLOUD_ACCESS_TOKEN || '').trim();
  if (!token) throw new Refusal('Set GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>)');
  // Checked here because fetch's own error for a bad header value would print the token.
  if (!/^[!-~]+$/.test(token)) {
    throw new Refusal('GCLOUD_ACCESS_TOKEN contains spaces or control characters; set it to the output of gcloud auth print-access-token alone.');
  }
  const api = restApi(token);
  if (opts.recordId !== null) return markReviewed(api, opts);

  // The whole collection in one read (it stays small); filtering and sorting happen here,
  // so no index is needed and records missing a field still show.
  const rows = await api('POST', `${FIRESTORE}:runQuery`, { structuredQuery: { from: [{ collectionId: COLLECTION }] } });
  const changes = (Array.isArray(rows) ? rows : []).filter(r => r.document).map(r => decodeDoc(r.document));
  console.log(formatListing(changes, opts));
}

module.exports = {
  COLLECTION,
  FIRESTORE,
  REVIEWED_BY,
  REVIEW_FIELDS,
  Refusal,
  isDocId,
  parseArgs,
  decodeValue,
  decodeFields,
  decodeDoc,
  selectChanges,
  changeTime,
  sortNewestFirst,
  formatValue,
  formatWhen,
  formatActor,
  formatReview,
  formatChange,
  formatListing,
  reviewRequest,
  main,
};

if (require.main === module) {
  main().catch(e => {
    console.error(e instanceof Refusal ? e.message : `FAILED: ${e.message}`);
    process.exit(1);
  });
}
