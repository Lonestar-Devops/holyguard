import { auth } from '../config/firebase';
import { FUNCTIONS_BASE_URL } from '../constants/links';
import { logger } from './logger';

/**
 * Client for the deleteAccount Cloud Function (functions/index.js).
 *
 * POST ${FUNCTIONS_BASE_URL}/deleteAccount with 'Authorization: Bearer <ID token>' and
 * JSON { newAdminUid?: string }. The server needs a recent sign-in (ID token auth_time
 * within 5 minutes), so the caller re-authenticates with the password first; this
 * function then forces a fresh ID token.
 *
 * Responses: 200 { deleted: true } | 401 { error: 'unauthenticated' }
 * | 403 { error: 'requires-recent-login' }
 * | 409 { error: 'last-admin', organizationName, members: [{ uid, name, role }] }
 * | 400 { error: 'invalid-new-admin' } | 405 (not POST) | 500 { error: 'internal' }.
 */

export const DELETE_ACCOUNT_URL = `${FUNCTIONS_BASE_URL}/deleteAccount`;

export type OrgMemberSummary = { uid: string; name: string; role: string };

export type DeleteAccountErrorCode =
    | 'requires-recent-login'
    | 'last-admin'
    | 'invalid-new-admin'
    | 'unauthenticated'
    | 'network'
    | 'internal';

export type DeleteAccountResult =
    | { ok: true }
    | {
          ok: false;
          error: DeleteAccountErrorCode;
          organizationName?: string;
          members?: Array<{ uid: string; name: string; role: string }>;
      };

// Firebase Auth codes from getIdToken(true) that mean the session can't continue: the
// account was deleted or disabled, or the refresh token was revoked or expired.
const SESSION_ENDED_CODES = new Set([
    'auth/user-not-found',
    'auth/user-disabled',
    'auth/user-token-expired',
    'auth/invalid-user-token',
]);

// Keep only well-formed entries from the server's member list.
const parseMembers = (value: unknown): OrgMemberSummary[] => {
    if (!Array.isArray(value)) return [];
    const members: OrgMemberSummary[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const { uid, name, role } = entry as Record<string, unknown>;
        if (typeof uid !== 'string' || !uid) continue;
        members.push({
            uid,
            name: typeof name === 'string' && name.trim() ? name.trim() : 'Member',
            role: typeof role === 'string' ? role : 'member',
        });
    }
    return members;
};

/**
 * Ask the server to delete the signed-in user's account and everything they authored.
 * Pass newAdminUid when the server answered 'last-admin': that member is made admin
 * first, then the account is deleted. Never throws.
 */
export async function deleteAccountRequest(newAdminUid?: string): Promise<DeleteAccountResult> {
    try {
        // A gate screen can render from the cached profile before Auth has restored the user.
        await auth.authStateReady();
    } catch (error) {
        logger.warn('deleteAccountRequest: authStateReady failed:', error);
    }
    const currentUser = auth.currentUser;
    if (!currentUser) {
        return { ok: false, error: 'unauthenticated' };
    }

    let idToken: string;
    try {
        // Force a refresh so the token carries the auth_time of the re-authentication.
        idToken = await currentUser.getIdToken(true);
    } catch (error: any) {
        const code = typeof error?.code === 'string' ? error.code : '';
        logger.warn('deleteAccountRequest: getIdToken failed:', code);
        if (SESSION_ENDED_CODES.has(code)) return { ok: false, error: 'unauthenticated' };
        if (code === 'auth/network-request-failed') return { ok: false, error: 'network' };
        return { ok: false, error: 'internal' };
    }

    let response: Response;
    try {
        response = await fetch(DELETE_ACCOUNT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify(newAdminUid ? { newAdminUid } : {}),
        });
    } catch (error) {
        logger.warn('deleteAccountRequest: network error:', error);
        return { ok: false, error: 'network' };
    }

    const body: any = await response.json().catch(() => null);
    const serverError = typeof body?.error === 'string' ? body.error : '';

    if (response.ok && body?.deleted === true) {
        return { ok: true };
    }

    logger.warn('deleteAccountRequest: rejected:', response.status, serverError);

    // Map only the function's own JSON error codes. A bare status from the hosting layer
    // (an HTML 403 when the function can't be invoked, a 400 for a malformed request, a 404
    // before it is deployed) is not the server's verdict: treating it as
    // 'requires-recent-login' or 'invalid-new-admin' would send the user round the password
    // or member-picker step forever.
    if (serverError === 'last-admin') {
        return {
            ok: false,
            error: 'last-admin',
            organizationName: typeof body?.organizationName === 'string' ? body.organizationName : '',
            members: parseMembers(body?.members),
        };
    }
    if (serverError === 'requires-recent-login') {
        return { ok: false, error: 'requires-recent-login' };
    }
    if (serverError === 'invalid-new-admin') {
        return { ok: false, error: 'invalid-new-admin' };
    }
    if (serverError === 'unauthenticated') {
        return { ok: false, error: 'unauthenticated' };
    }
    return { ok: false, error: 'internal' };
}
