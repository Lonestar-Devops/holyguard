import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { logger } from '../utils/logger';
import { Alert } from 'react-native';
import { UserProfile } from '../types';
import { auth, db } from '../config/firebase';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { doc, getDoc, collection, query, where, getDocs, type DocumentData, type DocumentSnapshot } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface AuthContextData {
    user: UserProfile | null;
    loading: boolean;
    logout: () => Promise<void>;
    refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextData>({} as AuthContextData);

const mapOrgStatus = (status: string | undefined): 'pending' | 'verified' | 'rejected' => {
    if (!status) return 'verified';
    if (status === 'Active') return 'verified';
    if (status === 'verified' || status === 'pending' || status === 'rejected') return status;
    return 'verified';
};

const USER_CACHE_KEY = '@holyguard_user_profile';

// ---------------------------------------------------------------------------------------
// Sign-up hold
//
// createUserWithEmailAndPassword signs the new user in at once, so the auth listener fires
// before SignUpScreen has written users/{uid} (and, for a new org, before the org, profile
// and #general channel exist). Loading the profile then would find nothing, fall back to a
// placeholder profile and swap SignUpScreen out mid-flow. So while a sign-up is in progress
// the listener waits instead of loading anything:
//   beginSignUp()     SignUpScreen calls it before creating the Auth user.
//   refreshProfile()  on success: ends the hold and loads the new profile.
//   endSignUp()       on failure (after the screen has signed out or removed the account),
//                     or when the screen goes away; the listener then loads the profile
//                     itself if someone is still signed in.
// The hold also ends by itself after SIGN_UP_HOLD_MAX_MS, so a stuck screen can never keep
// a signed-in user out of the app.
// ---------------------------------------------------------------------------------------
type HoldRelease = 'refreshed' | 'ended' | 'timeout';

const SIGN_UP_HOLD_MAX_MS = 2 * 60 * 1000;

let signUpInProgress = false;
let holdWaiters: Array<(how: HoldRelease) => void> = [];
let holdTimer: ReturnType<typeof setTimeout> | null = null;

const releaseSignUpHold = (how: HoldRelease) => {
    signUpInProgress = false;
    if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
    }
    const waiters = holdWaiters;
    holdWaiters = [];
    waiters.forEach(resolve => resolve(how));
};

export const beginSignUp = () => {
    signUpInProgress = true;
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => releaseSignUpHold('timeout'), SIGN_UP_HOLD_MAX_MS);
};

export const endSignUp = () => {
    if (signUpInProgress) {
        releaseSignUpHold('ended');
    }
};

const waitForSignUpHold = (): Promise<HoldRelease> =>
    new Promise(resolve => {
        if (!signUpInProgress) {
            resolve('ended');
            return;
        }
        holdWaiters.push(resolve);
    });

// ---------------------------------------------------------------------------------------
// Profile loading helpers
// ---------------------------------------------------------------------------------------

// A profile written moments ago may not be readable yet (sign-up, or an invite join whose
// profile write is still in flight). For a brand-new Auth user a missing profile is retried
// for about 10 seconds before the fallback is used.
const NEW_PROFILE_RETRY_DELAYS_MS = [500, 1000, 1500, 2000, 2500, 2500];
const NEW_ACCOUNT_WINDOW_MS = 10 * 60 * 1000;

const PROFILE_NOT_FOUND = 'profile-not-found';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const isNewAuthUser = (firebaseUser: User | null): boolean => {
    const created = Date.parse(firebaseUser?.metadata?.creationTime ?? '');
    return Number.isFinite(created) && Math.abs(Date.now() - created) < NEW_ACCOUNT_WINDOW_MS;
};

const readCachedProfile = async (): Promise<UserProfile | null> => {
    try {
        const cached = await AsyncStorage.getItem(USER_CACHE_KEY);
        return cached ? (JSON.parse(cached) as UserProfile) : null;
    } catch (error) {
        logger.error('Error reading cached user:', error);
        return null;
    }
};

// users/{userId}, retrying a missing doc when asked. Throws an error whose code is
// PROFILE_NOT_FOUND when the doc does not exist.
const getUserDoc = async (userId: string, waitForNewProfile: boolean): Promise<DocumentSnapshot<DocumentData>> => {
    const userDocRef = doc(db, 'users', userId);
    let snapshot = await getDoc(userDocRef);
    if (waitForNewProfile) {
        for (const delay of NEW_PROFILE_RETRY_DELAYS_MS) {
            if (snapshot.exists() || auth.currentUser?.uid !== userId) break;
            await sleep(delay);
            snapshot = await getDoc(userDocRef);
        }
    }
    if (!snapshot.exists()) {
        const notFound: any = new Error('User document not found');
        notFound.code = PROFILE_NOT_FOUND;
        throw notFound;
    }
    return snapshot;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);
    // Each profile load takes a ticket; only the newest load for the signed-in user may
    // set state, so a slow load can't overwrite a newer one or resurrect a signed-out user.
    const loadSeq = useRef(0);
    const signedOut = useRef(false);

    // Load cached user on mount for instant startup
    useEffect(() => {
        const loadCachedUser = async () => {
            const cachedUser = await readCachedProfile();
            if (!cachedUser || signedOut.current) return;
            if (auth.currentUser && auth.currentUser.uid !== cachedUser.id) return;
            // Never replace a profile the auth listener has already loaded.
            setUser(prev => prev ?? cachedUser);
            setLoading(false);
        };
        loadCachedUser();
    }, []);

    useEffect(() => {
        // Listen for auth changes
        const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
            if (firebaseUser) {
                signedOut.current = false;
                if (signUpInProgress) {
                    const how = await waitForSignUpHold();
                    // SignUpScreen's refreshProfile() already loads the new profile; and a
                    // failed sign-up has signed out (or removed the account) by now.
                    if (how === 'refreshed' || auth.currentUser?.uid !== firebaseUser.uid) {
                        setLoading(false);
                        return;
                    }
                }
                await fetchUserProfile(firebaseUser.uid, { waitForNewProfile: isNewAuthUser(firebaseUser) });
            } else {
                signedOut.current = true;
                loadSeq.current += 1; // drop any load still in flight
                setUser(null);
                await AsyncStorage.removeItem(USER_CACHE_KEY);
            }
            setLoading(false);
        });

        return () => {
            unsubscribe();
        };
    }, []);

    const fetchUserProfile = async (userId: string, options: { waitForNewProfile?: boolean } = {}) => {
        loadSeq.current += 1;
        const ticket = loadSeq.current;
        const isCurrent = () => loadSeq.current === ticket && auth.currentUser?.uid === userId;

        try {
            const userDoc = await getUserDoc(userId, options.waitForNewProfile === true);
            const userData = userDoc.data() as DocumentData;
            // The org as the security rules and Cloud Functions read it: organization_id wins
            // whenever present, and '' or 'removed' means no org.
            const profileOrgId = 'organization_id' in userData ? userData.organization_id : userData.organizationId;
            const orgId =
                typeof profileOrgId === 'string' && profileOrgId !== '' && profileOrgId !== 'removed'
                    ? profileOrgId
                    : 'default-org';

            // Fetch organization status and subscription info
            let orgStatus: 'pending' | 'verified' | 'rejected' = 'verified';
            let orgName = '';
            let subscriptionPlan: UserProfile['subscriptionPlan'] = undefined;
            let subscriptionStatus: UserProfile['subscriptionStatus'] = undefined;
            let maxSeats: number | undefined = undefined;

            if (orgId && orgId !== 'default-org') {
                // Find the org by its id field (existing pattern); a legacy org doc
                // with no id field is found by its doc id instead.
                const orgsQuery = query(collection(db, 'organizations'), where('id', '==', orgId));
                const orgSnapshot = await getDocs(orgsQuery);
                let orgData: DocumentData | null = null;
                if (!orgSnapshot.empty) {
                    orgData = orgSnapshot.docs[0].data();
                } else {
                    const orgDocSnap = await getDoc(doc(db, 'organizations', orgId));
                    if (orgDocSnap.exists()) {
                        orgData = orgDocSnap.data();
                    }
                }

                if (orgData) {
                    orgStatus = mapOrgStatus(orgData.status);
                    orgName = orgData.name || '';
                    // The app only reads these; the server sets them (validateAppleReceipt
                    // and the App Store notifications endpoint).
                    subscriptionPlan = orgData.subscriptionPlan || undefined;
                    subscriptionStatus = orgData.subscriptionStatus || undefined;
                    maxSeats = orgData.maxSeats || undefined;

                    // Grandfathered orgs count as active without a subscription
                    if (orgData.grandfathered === true) {
                        subscriptionStatus = 'active';
                        subscriptionPlan = undefined;
                    }
                }
            }

            const blockedUsers = Array.isArray(userData.blockedUsers)
                ? userData.blockedUsers.filter((uid: unknown): uid is string => typeof uid === 'string')
                : undefined;

            const profile: UserProfile = {
                id: userId,
                name: userData.name || auth.currentUser?.displayName || 'User',
                role: userData.role || 'member',
                organizationId: orgId,
                emailVerified: auth.currentUser?.emailVerified || false,
                organizationStatus: orgStatus,
                organizationName: orgName,
                tosAcceptedAt: userData.tosAcceptedAt || userData.tos_accepted_at || undefined,
                subscriptionPlan,
                subscriptionStatus,
                maxSeats,
                blockedUsers,
            };

            if (!isCurrent()) return;
            setUser(profile);
            try {
                await AsyncStorage.setItem(USER_CACHE_KEY, JSON.stringify(profile));
            } catch (cacheError) {
                // The fresh profile is already in use; only the next cold start loses it.
                logger.error('Error caching user profile:', cacheError);
            }
        } catch (error: any) {
            if (!isCurrent()) return;
            logger.error('Error fetching user profile:', error);

            const profileMissing = error?.code === PROFILE_NOT_FOUND;

            // Offline launch or any other transient failure: keep the last good profile for
            // this user instead of a placeholder (which would send them to the Terms screen).
            if (!profileMissing) {
                const cached = await readCachedProfile();
                if (!isCurrent()) return;
                if (cached && cached.id === userId) {
                    setUser(cached);
                    return;
                }
            }

            // Fallback: a placeholder profile from Firebase Auth data. It is not cached, so
            // the next launch loads the real profile again.
            const fallbackProfile: UserProfile = {
                id: userId,
                name: auth.currentUser?.displayName || auth.currentUser?.email?.split('@')[0] || 'User',
                role: 'member',
                organizationId: 'default-org',
                emailVerified: auth.currentUser?.emailVerified || false,
                organizationStatus: 'verified',
            };

            setUser(fallbackProfile);
            await AsyncStorage.removeItem(USER_CACHE_KEY).catch((cacheError) => {
                logger.error('Error clearing cached user profile:', cacheError);
            });

            if (!signUpInProgress) {
                Alert.alert(
                    'Notice',
                    profileMissing
                        ? 'Could not load profile. Please try logging out and back in.'
                        : 'Could not load your profile. Check your connection, then log out and back in.',
                );
            }
        }
    };

    const refreshProfile = async () => {
        // Called by SignUpScreen once the new profile is written: end the hold so the
        // waiting auth listener stands down, then load the profile here.
        if (signUpInProgress) {
            releaseSignUpHold('refreshed');
        }
        const current = auth.currentUser;
        if (current) {
            await fetchUserProfile(current.uid, { waitForNewProfile: isNewAuthUser(current) });
        }
    };

    const logout = async () => {
        await AsyncStorage.removeItem(USER_CACHE_KEY);
        await signOut(auth);
    };

    return (
        <AuthContext.Provider value={{ user, loading, logout, refreshProfile }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
