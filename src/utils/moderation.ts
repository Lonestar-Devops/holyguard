// Basic user-generated-content moderation: report content to support by email, and
// block users. A block is stored on the blocker's own profile as users/{uid}.blockedUsers
// (an array of uids, at most MAX_BLOCKED_USERS). Screens read it with useBlockedUsers()
// and hide that user from the directory, direct messages, message requests and Resources;
// the security rules stop new message requests from a blocked user. Team channel messages
// stay visible (an org's own channel carries its security traffic); org admins can delete
// them instead.
import { useEffect, useState } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import Constants from 'expo-constants';
import { onAuthStateChanged } from 'firebase/auth';
import {
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  updateDoc,
  type DocumentData,
} from 'firebase/firestore';
import { auth, db } from '../config/firebase';
import { SUPPORT_EMAIL } from '../constants/links';
import { logger } from './logger';

export const MAX_BLOCKED_USERS = 500;
const MAX_EXCERPT_LENGTH = 200;

export type ReportContentType = 'resource' | 'direct_message' | 'conversation' | 'user' | 'team_message';

export interface ReportContentParams {
  contentType: ReportContentType;
  contentId?: string;
  reportedUserId?: string;
  reportedUserName?: string;
  excerpt?: string;
}

const CONTENT_LABELS: Record<ReportContentType, string> = {
  resource: 'Resource post',
  direct_message: 'Direct message',
  conversation: 'Conversation',
  user: 'User',
  team_message: 'Team message',
};

// Where support finds the reported item in the Firestore console.
const CONTENT_COLLECTIONS: Record<ReportContentType, string> = {
  resource: 'resources',
  direct_message: 'direct_messages',
  conversation: 'conversations',
  user: 'users',
  team_message: 'team_messages',
};

const shortenExcerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_EXCERPT_LENGTH ? `${flat.slice(0, MAX_EXCERPT_LENGTH - 3)}...` : flat;
};

/**
 * Opens the mail app with a report to support, prefilled with what support needs to find
 * the content (collection path, ids, a short excerpt). If no mail app can be opened, shows
 * the support address instead. Never throws.
 */
export async function reportContent(params: ReportContentParams): Promise<void> {
  const { contentType, contentId, reportedUserId, reportedUserName, excerpt } = params;
  const label = CONTENT_LABELS[contentType] || 'Content';
  const reporterId = auth.currentUser?.uid || 'unknown';
  const reference = contentId ? `${CONTENT_COLLECTIONS[contentType]}/${contentId}` : '';

  const details: string[] = [`Type: ${label}`];
  if (reference) details.push(`Content: ${reference}`);
  if (reportedUserId || reportedUserName) {
    const who = reportedUserName ? shortenExcerpt(reportedUserName) : 'Unknown';
    details.push(`Reported user: ${who}${reportedUserId ? ` (users/${reportedUserId})` : ''}`);
  }
  if (excerpt && excerpt.trim()) details.push(`Excerpt: "${shortenExcerpt(excerpt)}"`);
  details.push(`Reported by: users/${reporterId}`);
  details.push(`Time: ${new Date().toISOString()}`);
  details.push(`App: HolyGuard ${Constants.expoConfig?.version || ''} (${Platform.OS} ${String(Platform.Version)})`);

  const subject = `HolyGuard report: ${label}${reportedUserName ? ` from ${shortenExcerpt(reportedUserName)}` : ''}`;
  const body = [
    'Please tell us what is wrong with this content (optional):',
    '',
    '',
    '',
    '--- Report details (please keep this section) ---',
    ...details,
  ].join('\n');

  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  try {
    await Linking.openURL(url);
  } catch (error) {
    logger.warn('Could not open the mail app for a report:', error);
    Alert.alert(
      'Report',
      `No mail app is available on this device. To report this, email ${SUPPORT_EMAIL}` +
        (reference ? ` and include this reference: ${reference}` : '') +
        '. We review every report promptly.'
    );
  }
}

/** Adds uid to the signed-in user's own blockedUsers list. Throws on failure. */
export async function blockUser(uid: string): Promise<void> {
  const me = auth.currentUser?.uid;
  if (!me) throw new Error('not-signed-in');
  if (!uid || uid === me) throw new Error('invalid-user');

  const profileRef = doc(db, 'users', me);
  const snap = await getDoc(profileRef);
  const current = snap.exists() ? snap.data().blockedUsers : undefined;
  const list: unknown[] = Array.isArray(current) ? current : [];
  if (list.includes(uid)) return;
  if (list.length >= MAX_BLOCKED_USERS) throw new Error('block-limit');

  await updateDoc(profileRef, { blockedUsers: arrayUnion(uid) });
}

/** Removes uid from the signed-in user's own blockedUsers list. Throws on failure. */
export async function unblockUser(uid: string): Promise<void> {
  const me = auth.currentUser?.uid;
  if (!me) throw new Error('not-signed-in');
  if (!uid) return;
  await updateDoc(doc(db, 'users', me), { blockedUsers: arrayRemove(uid) });
}

/**
 * Asks for confirmation, then blocks the user. Errors are shown inline; onBlocked runs
 * only after the block is saved.
 */
export function confirmBlockUser(options: { uid: string; name?: string; onBlocked?: () => void }): void {
  const { uid, name, onBlocked } = options;
  const who = name && name.trim() ? name.trim() : 'this user';
  Alert.alert(
    `Block ${who}?`,
    'You will no longer see their direct messages, message requests or resource posts, and they will not be able to send you new message requests. They are not notified. You can unblock them in Settings > Blocked Users.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Block',
        style: 'destructive',
        onPress: async () => {
          try {
            await blockUser(uid);
            onBlocked?.();
          } catch (error: any) {
            logger.error('Error blocking user:', error);
            Alert.alert(
              'Could not block',
              error?.message === 'block-limit'
                ? `You can block up to ${MAX_BLOCKED_USERS} users. Unblock someone in Settings > Blocked Users first.`
                : 'Something went wrong. Please check your connection and try again.'
            );
          }
        },
      },
    ]
  );
}

const EMPTY_BLOCKED: Set<string> = new Set();

/** Live view of the signed-in user's own blockedUsers list. */
export function useBlockedUsers(): { blocked: Set<string>; loading: boolean } {
  const [state, setState] = useState<{ blocked: Set<string>; loading: boolean }>({
    blocked: EMPTY_BLOCKED,
    loading: true,
  });

  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      unsubscribeProfile?.();
      unsubscribeProfile = null;

      if (!firebaseUser) {
        setState({ blocked: EMPTY_BLOCKED, loading: false });
        return;
      }

      unsubscribeProfile = onSnapshot(
        doc(db, 'users', firebaseUser.uid),
        (snap) => {
          const raw = snap.exists() ? snap.data().blockedUsers : undefined;
          const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id !== '') : [];
          setState({ blocked: new Set(ids), loading: false });
        },
        (error) => {
          logger.error('Error listening to blocked users:', error);
          setState((prev) => ({ ...prev, loading: false }));
        }
      );
    });

    return () => {
      unsubscribeAuth();
      unsubscribeProfile?.();
    };
  }, []);

  return state;
}

/**
 * A profile's org id as the security rules read it: organization_id wins whenever present;
 * '' or 'removed' means no org.
 */
export function profileOrgId(data: DocumentData | undefined): string {
  if (!data) return '';
  const raw = 'organization_id' in data ? data.organization_id : data.organizationId;
  return typeof raw === 'string' && raw !== '' && raw !== 'removed' ? raw : '';
}

/**
 * Org names keyed by both the org's `id` field ('org_<ms>' for app-created orgs) and its
 * doc id, so either spelling a profile carries resolves. Empty on failure.
 */
export async function loadOrgNameMap(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const snapshot = await getDocs(collection(db, 'organizations'));
    snapshot.docs.forEach((orgDoc) => {
      const data = orgDoc.data();
      const name = typeof data.name === 'string' ? data.name : '';
      if (!name) return;
      if (!names.has(orgDoc.id)) names.set(orgDoc.id, name);
      if (typeof data.id === 'string' && data.id) names.set(data.id, name);
    });
  } catch (error) {
    logger.error('Error loading organization names:', error);
  }
  return names;
}
