import React, { useEffect, useRef, useState } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    ScrollView,
    Modal,
    KeyboardAvoidingView,
    Platform,
    ActivityIndicator,
    Alert,
    Linking,
    StyleSheet,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { EmailAuthProvider, reauthenticateWithCredential, signOut } from 'firebase/auth';
import { auth } from '../config/firebase';
import { theme } from '../theme';
import { useAuth } from '../context/AuthContext';
import { MANAGE_SUBSCRIPTIONS_URL, SUPPORT_EMAIL } from '../constants/links';
import { deleteAccountRequest, type OrgMemberSummary } from '../utils/accountApi';
import { logger } from '../utils/logger';

// The profile cache AuthContext keeps (USER_CACHE_KEY there).
const USER_CACHE_KEY = '@holyguard_user_profile';

type Step = 'explain' | 'password' | 'choose-admin';

interface DeleteAccountModalProps {
    visible: boolean;
    onClose: () => void;
}

const reauthErrorMessage = (code: string | undefined): string => {
    switch (code) {
        case 'auth/invalid-credential':
        case 'auth/invalid-login-credentials':
        case 'auth/wrong-password':
            return 'That password is incorrect. Please try again.';
        case 'auth/too-many-requests':
            return 'Too many attempts. Please wait a few minutes and try again.';
        case 'auth/network-request-failed':
            return "Couldn't connect. Check your internet connection and try again.";
        case 'auth/user-not-found':
        case 'auth/user-mismatch':
        case 'auth/user-disabled':
        case 'auth/user-token-expired':
            return 'Your session has ended. Sign out, sign back in, and try again.';
        default:
            return "We couldn't verify your password. Please try again.";
    }
};

const SESSION_ENDED_REAUTH_CODES = new Set([
    'auth/user-not-found',
    'auth/user-mismatch',
    'auth/user-disabled',
    'auth/user-token-expired',
]);

const roleLabel = (role: string): string => {
    if (role === 'super_admin') return 'Super Admin';
    if (!role) return 'Member';
    return role.charAt(0).toUpperCase() + role.slice(1);
};

/**
 * Deletes the signed-in user's account from inside the app (App Store Guideline 5.1.1(v)).
 * Steps: explain what is deleted -> confirm the password -> the deleteAccount Cloud
 * Function. If the user is the only admin of an org that still has members, the server
 * answers 'last-admin' with the member list; the user picks a new admin here and the
 * request is retried with newAdminUid. On success the local profile cache is cleared and
 * the app signs out.
 */
export const DeleteAccountModal: React.FC<DeleteAccountModalProps> = ({ visible, onClose }) => {
    const { user, logout } = useAuth();
    const [step, setStep] = useState<Step>('explain');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sessionEnded, setSessionEnded] = useState(false);
    const [orgName, setOrgName] = useState('');
    const [members, setMembers] = useState<OrgMemberSummary[]>([]);
    const [newAdminUid, setNewAdminUid] = useState<string | null>(null);
    // Set synchronously, so a double tap (or Done on the keyboard plus the button) can't
    // start a second request before `busy` has re-rendered the buttons as disabled.
    const inFlight = useRef(false);

    // Start over every time the modal opens.
    useEffect(() => {
        if (!visible) return;
        setStep('explain');
        setPassword('');
        setBusy(false);
        setError(null);
        setSessionEnded(false);
        setOrgName('');
        setMembers([]);
        setNewAdminUid(null);
    }, [visible]);

    const email = auth.currentUser?.email ?? '';
    const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
    const chosenAdmin = members.find((m) => m.uid === newAdminUid) ?? null;

    const handleClose = () => {
        if (busy) return;
        onClose();
    };

    const openManageSubscriptions = async () => {
        try {
            await Linking.openURL(MANAGE_SUBSCRIPTIONS_URL);
        } catch (err) {
            logger.warn('Open Manage Subscriptions failed:', err);
            Alert.alert('Manage Subscriptions', `Open ${MANAGE_SUBSCRIPTIONS_URL} or go to Settings > Apple ID > Subscriptions.`);
        }
    };

    const handleSignOut = async () => {
        try {
            await logout();
        } catch (err) {
            logger.warn('Sign out after ended session failed:', err);
        }
    };

    // The server has deleted everything, the Auth user last. Signing out can fail because
    // that user no longer exists; the local session is cleared either way.
    const finishDeleted = async () => {
        try {
            await AsyncStorage.removeItem(USER_CACHE_KEY);
        } catch (err) {
            logger.warn('Clearing the profile cache failed:', err);
        }
        try {
            await signOut(auth);
        } catch (err) {
            logger.warn('Sign out after account deletion failed:', err);
        }
        Alert.alert('Account Deleted', 'Your HolyGuard account and data have been permanently deleted.');
    };

    const runDelete = async (adminUid: string | null) => {
        const result = await deleteAccountRequest(adminUid ?? undefined);
        if (result.ok) {
            await finishDeleted();
            return;
        }
        switch (result.error) {
            case 'last-admin': {
                const list = result.members ?? [];
                setOrgName(result.organizationName || user?.organizationName || '');
                setMembers(list);
                setNewAdminUid((prev) => (prev && list.some((m) => m.uid === prev) ? prev : null));
                setError(null);
                setStep('choose-admin');
                break;
            }
            case 'requires-recent-login':
                // The 5-minute window passed (or the token was stale). Any chosen admin is kept.
                setPassword('');
                setStep('password');
                setError('For your security, enter your password again to continue.');
                break;
            case 'invalid-new-admin':
                setMembers((prev) => prev.filter((m) => m.uid !== adminUid));
                setNewAdminUid(null);
                setStep('choose-admin');
                setError("That member can't be made admin. They may have left the organization. Choose someone else.");
                break;
            case 'unauthenticated':
                setSessionEnded(true);
                setError('Your session has ended. Sign out, sign back in, and try again.');
                break;
            case 'network':
                setError("Couldn't reach HolyGuard. Check your internet connection and try again.");
                break;
            default:
                setError(`Your account could not be deleted. Please try again. If this keeps happening, email ${SUPPORT_EMAIL}.`);
        }
    };

    const handlePasswordSubmit = async () => {
        if (busy || inFlight.current) return;
        if (!password) {
            setError('Enter your password to continue.');
            return;
        }
        inFlight.current = true;
        setBusy(true);
        setError(null);
        try {
            await auth.authStateReady();
            const currentUser = auth.currentUser;
            if (!currentUser || !currentUser.email) {
                setSessionEnded(true);
                setError('Your session has ended. Sign out, sign back in, and try again.');
                return;
            }
            try {
                const credential = EmailAuthProvider.credential(currentUser.email, password);
                await reauthenticateWithCredential(currentUser, credential);
            } catch (err: any) {
                const code = typeof err?.code === 'string' ? err.code : undefined;
                logger.warn('Re-authentication for account deletion failed:', code);
                if (code && SESSION_ENDED_REAUTH_CODES.has(code)) setSessionEnded(true);
                setError(reauthErrorMessage(code));
                return;
            }
            setPassword('');
            await runDelete(newAdminUid);
        } catch (err) {
            logger.error('Account deletion failed:', err);
            setError(`Your account could not be deleted. Please try again. If this keeps happening, email ${SUPPORT_EMAIL}.`);
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    };

    const handleChooseAdminSubmit = async (adminUid: string | null) => {
        if (busy || inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setError(null);
        try {
            await runDelete(adminUid);
        } catch (err) {
            logger.error('Account deletion with new admin failed:', err);
            setError(`Your account could not be deleted. Please try again. If this keeps happening, email ${SUPPORT_EMAIL}.`);
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    };

    const renderError = () =>
        error ? (
            <View style={styles.errorBox} accessibilityLiveRegion="polite">
                <MaterialCommunityIcons name="alert-circle-outline" size={18} color={theme.colors.danger} />
                <View style={styles.errorBody}>
                    <Text style={styles.errorText}>{error}</Text>
                    {sessionEnded && (
                        <TouchableOpacity onPress={handleSignOut} style={styles.errorAction} accessibilityRole="button">
                            <Text style={styles.errorActionText}>Sign Out</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </View>
        ) : null;

    const renderExplain = () => (
        <>
            <View style={styles.iconWrap}>
                <MaterialCommunityIcons name="account-remove-outline" size={40} color={theme.colors.danger} />
            </View>
            <Text style={styles.title}>Delete your account?</Text>
            <Text style={styles.body}>
                This permanently deletes your HolyGuard account and everything you've added, including incident
                reports, watchlist entries, resources, team and direct messages, and your profile. This can't be undone.
            </Text>
            {isAdmin && (
                <Text style={styles.body}>
                    If you're the only admin of your organization, you'll choose a new admin before your account is deleted.
                </Text>
            )}
            <View style={styles.noteBox}>
                <MaterialCommunityIcons name="information-outline" size={18} color={theme.colors.textSecondary} />
                <View style={styles.noteBody}>
                    <Text style={styles.noteText}>
                        If you subscribed through the App Store, deleting your account does not cancel the subscription.
                        Cancel it in your App Store subscriptions to stop future charges.
                    </Text>
                    <TouchableOpacity onPress={openManageSubscriptions} accessibilityRole="link">
                        <Text style={styles.linkText}>Manage Subscriptions</Text>
                    </TouchableOpacity>
                </View>
            </View>
            {renderError()}
            <View style={styles.buttonRow}>
                <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={handleClose} accessibilityRole="button">
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.button, styles.dangerButton]}
                    onPress={() => {
                        setError(null);
                        setStep('password');
                    }}
                    accessibilityRole="button"
                >
                    <Text style={styles.dangerButtonText}>Continue</Text>
                </TouchableOpacity>
            </View>
        </>
    );

    const renderPassword = () => (
        <>
            <Text style={styles.title}>Confirm it's you</Text>
            <Text style={styles.body}>
                {email
                    ? `Enter the password for ${email} to permanently delete your account.`
                    : 'Enter your password to permanently delete your account.'}
            </Text>
            {chosenAdmin && (
                <Text style={styles.body}>
                    {chosenAdmin.name} will become the admin of {orgName || 'your organization'}.
                </Text>
            )}
            <TextInput
                style={styles.input}
                value={password}
                onChangeText={(text) => {
                    setPassword(text);
                    if (error && !sessionEnded) setError(null);
                }}
                placeholder="Password"
                placeholderTextColor={theme.colors.gray}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="done"
                onSubmitEditing={handlePasswordSubmit}
                editable={!busy}
                autoFocus
                accessibilityLabel="Password"
            />
            {renderError()}
            <View style={styles.buttonRow}>
                <TouchableOpacity
                    style={[styles.button, styles.secondaryButton, busy && styles.buttonDisabled]}
                    onPress={handleClose}
                    disabled={busy}
                    accessibilityRole="button"
                >
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.button, styles.dangerButton, (busy || !password) && styles.buttonDisabled]}
                    onPress={handlePasswordSubmit}
                    disabled={busy || !password}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy || !password, busy }}
                >
                    {busy ? (
                        <ActivityIndicator color={theme.colors.white} />
                    ) : (
                        <Text style={styles.dangerButtonText}>Delete Account</Text>
                    )}
                </TouchableOpacity>
            </View>
        </>
    );

    const renderChooseAdmin = () => (
        <>
            <View style={styles.iconWrap}>
                <MaterialCommunityIcons name="account-key-outline" size={40} color={theme.colors.primary} />
            </View>
            <Text style={styles.title}>Choose a new admin</Text>
            <Text style={styles.body}>
                You're the only admin of {orgName || 'your organization'}. Choose a new admin before deleting your account.
            </Text>
            {members.length > 0 ? (
                <View style={styles.memberList}>
                    {members.map((member) => {
                        const selected = member.uid === newAdminUid;
                        return (
                            <TouchableOpacity
                                key={member.uid}
                                style={[styles.memberRow, selected && styles.memberRowSelected]}
                                onPress={() => {
                                    setNewAdminUid(member.uid);
                                    setError(null);
                                }}
                                disabled={busy}
                                accessibilityRole="radio"
                                accessibilityState={{ checked: selected, disabled: busy }}
                                accessibilityLabel={`${member.name}, ${roleLabel(member.role)}`}
                            >
                                <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
                                    {selected && <View style={styles.radioInner} />}
                                </View>
                                <View style={styles.memberInfo}>
                                    <Text style={styles.memberName} numberOfLines={1}>
                                        {member.name}
                                    </Text>
                                    <Text style={styles.memberRole}>{roleLabel(member.role)}</Text>
                                </View>
                            </TouchableOpacity>
                        );
                    })}
                </View>
            ) : (
                <Text style={styles.body}>
                    No member can be chosen right now. Tap Continue to check again. If you're no longer the only
                    admin, your account will be deleted.
                </Text>
            )}
            {renderError()}
            <View style={styles.buttonRow}>
                <TouchableOpacity
                    style={[styles.button, styles.secondaryButton, busy && styles.buttonDisabled]}
                    onPress={handleClose}
                    disabled={busy}
                    accessibilityRole="button"
                >
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
                {members.length > 0 ? (
                    <TouchableOpacity
                        style={[styles.button, styles.dangerButton, (busy || !newAdminUid) && styles.buttonDisabled]}
                        onPress={() => handleChooseAdminSubmit(newAdminUid)}
                        disabled={busy || !newAdminUid}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: busy || !newAdminUid, busy }}
                    >
                        {busy ? (
                            <ActivityIndicator color={theme.colors.white} />
                        ) : (
                            <Text style={styles.dangerButtonText}>Make Admin & Delete</Text>
                        )}
                    </TouchableOpacity>
                ) : (
                    <TouchableOpacity
                        style={[styles.button, styles.dangerButton, busy && styles.buttonDisabled]}
                        onPress={() => handleChooseAdminSubmit(null)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: busy, busy }}
                    >
                        {busy ? (
                            <ActivityIndicator color={theme.colors.white} />
                        ) : (
                            <Text style={styles.dangerButtonText}>Continue</Text>
                        )}
                    </TouchableOpacity>
                )}
            </View>
        </>
    );

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
            <KeyboardAvoidingView
                style={styles.overlay}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                <View style={styles.card} accessibilityViewIsModal>
                    <View style={styles.header}>
                        <Text style={styles.headerTitle}>Delete Account</Text>
                        <TouchableOpacity
                            onPress={handleClose}
                            disabled={busy}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            accessibilityRole="button"
                            accessibilityLabel="Close"
                        >
                            <MaterialCommunityIcons
                                name="close"
                                size={24}
                                color={busy ? theme.colors.borderStrong : theme.colors.textPrimary}
                            />
                        </TouchableOpacity>
                    </View>
                    <ScrollView
                        style={styles.scroll}
                        contentContainerStyle={styles.content}
                        keyboardShouldPersistTaps="handled"
                        bounces={false}
                    >
                        {step === 'explain' && renderExplain()}
                        {step === 'password' && renderPassword()}
                        {step === 'choose-admin' && renderChooseAdmin()}
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    card: {
        width: '100%',
        maxWidth: 480,
        maxHeight: '90%',
        flexShrink: 1,
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: theme.spacing.m,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: theme.colors.textPrimary,
    },
    scroll: {
        flexGrow: 0,
        flexShrink: 1,
    },
    content: {
        padding: theme.spacing.m,
        paddingBottom: theme.spacing.l,
    },
    iconWrap: {
        alignItems: 'center',
        marginBottom: 8,
    },
    title: {
        fontSize: 20,
        fontWeight: '800',
        color: theme.colors.textPrimary,
        textAlign: 'center',
        marginBottom: 12,
    },
    body: {
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
        marginBottom: 12,
    },
    noteBox: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: theme.colors.background,
        borderRadius: 10,
        padding: 12,
        marginBottom: 12,
    },
    noteBody: {
        flex: 1,
        marginLeft: 8,
    },
    noteText: {
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
    },
    linkText: {
        fontSize: 14,
        fontWeight: '700',
        color: theme.colors.primary,
        textDecorationLine: 'underline',
        marginTop: 8,
    },
    input: {
        borderWidth: 1,
        borderColor: theme.colors.borderStrong,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        fontSize: 16,
        color: theme.colors.textPrimary,
        backgroundColor: theme.colors.white,
        marginBottom: 12,
    },
    errorBox: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: '#FDECEA',
        borderRadius: 8,
        padding: 10,
        marginBottom: 12,
    },
    errorBody: {
        flex: 1,
        marginLeft: 8,
    },
    errorText: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.danger,
    },
    errorAction: {
        alignSelf: 'flex-start',
        marginTop: 8,
        paddingVertical: 4,
    },
    errorActionText: {
        fontSize: 14,
        fontWeight: '700',
        color: theme.colors.textPrimary,
        textDecorationLine: 'underline',
    },
    memberList: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        marginBottom: 12,
        overflow: 'hidden',
    },
    memberRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.white,
    },
    memberRowSelected: {
        backgroundColor: theme.colors.background,
    },
    memberInfo: {
        flex: 1,
        marginLeft: 12,
    },
    memberName: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.textPrimary,
    },
    memberRole: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    radioOuter: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.borderStrong,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioOuterSelected: {
        borderColor: theme.colors.primary,
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.primary,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 4,
    },
    button: {
        flex: 1,
        minHeight: 48,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
    },
    secondaryButton: {
        borderWidth: 1,
        borderColor: theme.colors.borderStrong,
        backgroundColor: theme.colors.white,
    },
    secondaryButtonText: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.textPrimary,
    },
    dangerButton: {
        backgroundColor: theme.colors.danger,
    },
    dangerButtonText: {
        fontSize: 15,
        fontWeight: '700',
        color: theme.colors.white,
        textAlign: 'center',
    },
    buttonDisabled: {
        opacity: 0.5,
    },
});
