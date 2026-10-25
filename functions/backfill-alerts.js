/**
 * One-time script to backfill organizationId on existing alerts.
 * Run from the functions/ directory: node backfill-alerts.js
 */
const admin = require('firebase-admin');
const { GoogleAuth } = require('google-auth-library');

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

admin.initializeApp({
  projectId: 'holyguard-app',
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

async function backfillAlerts() {
  const alertsSnapshot = await db.collection('alerts').get();
  console.log(`Found ${alertsSnapshot.size} alerts to process`);

  let updated = 0;
  let skipped = 0;

  for (const alertDoc of alertsSnapshot.docs) {
    const data = alertDoc.data();

    // Skip if already has organizationId
    if (data.organizationId) {
      skipped++;
      continue;
    }

    let orgId = null;

    // The location field was used to store the org ID
    if (data.location && data.location.startsWith('org_')) {
      orgId = data.location;
    }

    // Fallback: look up the reporter's org
    if (!orgId && data.reporterId) {
      try {
        const userDoc = await db.collection('users').doc(data.reporterId).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          orgId = userData.organization_id || userData.organizationId;
        }
      } catch (e) {
        console.error(`Error looking up user ${data.reporterId}:`, e.message);
      }
    }

    if (orgId) {
      await alertDoc.ref.update({ organizationId: orgId });
      updated++;
      console.log(`Updated alert ${alertDoc.id} → org ${orgId}`);
    } else {
      console.log(`Skipped alert ${alertDoc.id} — no org found`);
      skipped++;
    }
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
  process.exit(0);
}

backfillAlerts().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
