import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput, Alert, ScrollView } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { theme } from '../theme';
import { useAuth } from '../context/AuthContext';
import { db, auth } from '../config/firebase';
import { collection, query, where, getDocs, getDoc, doc, onSnapshot, type DocumentData } from 'firebase/firestore';
import { logger } from '../utils/logger';
import { FUNCTIONS_BASE_URL } from '../constants/links';
import { AccountActions } from '../components/AccountActions';

// Verification checks shown while an organization is pending. The organization email check
// is left out: its code is never delivered, so it can't be completed.
const CHECK_ROWS: Array<{ key: string; label: string }> = [
    { key: 'googlePlaces', label: 'Google Places' },
    { key: 'einVerification', label: 'EIN / 501(c)(3)' },
    { key: 'phoneSms', label: 'Phone' },
];

export const PendingApprovalScreen = () => {
    const { user, refreshProfile } = useAuth();
    const [checking, setChecking] = useState(false);
    const [verificationChecks, setVerificationChecks] = useState<any>(null);
    const [loadingChecks, setLoadingChecks] = useState(true);
    // The org's Firestore doc id (the verification endpoints take it) and its data.
    const [orgDocId, setOrgDocId] = useState<string | null>(null);
    const [orgData, setOrgData] = useState<DocumentData | null>(null);
    const [runningChecks, setRunningChecks] = useState(false);

    // Phone verification state
    const [showPhoneVerify, setShowPhoneVerify] = useState(false);
    const [phoneInput, setPhoneInput] = useState('');
    const [phoneVerifying, setPhoneVerifying] = useState(false);

    // Real-time listeners on the org's status and its verification checks
    useEffect(() => {
        const organizationId = user?.organizationId;
        if (!organizationId || organizationId === 'default-org') {
            setLoadingChecks(false);
            return;
        }

        let cancelled = false;
        const unsubscribers: Array<() => void> = [];

        const loadOrgAndListen = async () => {
            try {
                // Find the org by its id field; a legacy org with no id field by its doc id.
                const orgSnapshot = await getDocs(query(collection(db, 'organizations'), where('id', '==', organizationId)));
                let docId: string | null = orgSnapshot.empty ? null : orgSnapshot.docs[0].id;
                if (!docId) {
                    const byDocId = await getDoc(doc(db, 'organizations', organizationId));
                    docId = byDocId.exists() ? byDocId.id : null;
                }
                if (cancelled) return;
                if (!docId) {
                    setLoadingChecks(false);
                    return;
                }
                setOrgDocId(docId);

                // Status changes (approved or rejected) move the user on to the next screen.
                unsubscribers.push(onSnapshot(
                    doc(db, 'organizations', docId),
                    (snapshot) => {
                        const data = snapshot.data();
                        setOrgData(data ?? null);
                        if (data?.status === 'verified' || data?.status === 'Active' || data?.status === 'rejected') {
                            refreshProfile();
                        }
                    },
                    (error) => logger.error('Organization listener error:', error),
                ));

                unsubscribers.push(onSnapshot(
                    doc(db, 'organizations', docId, 'verification', 'checks'),
                    (snapshot) => {
                        setVerificationChecks(snapshot.exists() ? snapshot.data() : null);
                        setLoadingChecks(false);
                    },
                    (error) => {
                        logger.error('Verification checks listener error:', error);
                        setLoadingChecks(false);
                    },
                ));

                // The effect may have been cleaned up while the listeners were being set up.
                if (cancelled) {
                    unsubscribers.forEach(unsubscribe => unsubscribe());
                }
            } catch (error) {
                logger.error('Error loading organization:', error);
                if (!cancelled) setLoadingChecks(false);
            }
        };

        loadOrgAndListen();

        return () => {
            cancelled = true;
            unsubscribers.forEach(unsubscribe => unsubscribe());
        };
    }, [user?.organizationId]);

    const handleCheckStatus = async () => {
        setChecking(true);
        await refreshProfile();
        setChecking(false);
    };

    // Runs the automated checks when they never ran (for example, sign-up lost its
    // connection before they finished). Resends the details the org was submitted with.
    const handleRunChecks = async () => {
        // verifyOrganization overwrites the org's ein/website/phone with what it is sent,
        // so wait until the org doc has loaded rather than send blanks.
        if (!orgDocId || !orgData || !auth.currentUser) return;
        setRunningChecks(true);
        try {
            const idToken = await auth.currentUser.getIdToken();
            const response = await fetch(`${FUNCTIONS_BASE_URL}/verifyOrganization`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${idToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    organizationId: orgDocId,
                    ein: orgData?.ein || undefined,
                    website: orgData?.website || undefined,
                    phone: orgData?.phone || undefined,
                    orgEmail: orgData?.orgEmail || undefined,
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                Alert.alert('Error', data.error || 'Could not run the verification checks. Please try again.');
                return;
            }
            if (data.status === 'verified' || data.alreadyVerified) {
                Alert.alert('Verified!', 'Your organization has been approved!');
                await refreshProfile();
            } else {
                Alert.alert(
                    'Checks Complete',
                    `Score: ${data.score || 0} points. A HolyGuard administrator will review your organization.`
                );
            }
        } catch (error) {
            logger.error('Error running verification checks:', error);
            Alert.alert('Error', 'Could not run the verification checks. Please check your connection and try again.');
        } finally {
            setRunningChecks(false);
        }
    };

    const handlePhoneVerify = async () => {
        if (!phoneInput.trim()) {
            Alert.alert('Error', 'Please enter the organization phone number');
            return;
        }
        if (!orgDocId || !auth.currentUser) {
            Alert.alert('Error', 'Organization not found. Please try again.');
            return;
        }

        setPhoneVerifying(true);
        try {
            const idToken = await auth.currentUser.getIdToken();
            const response = await fetch(`${FUNCTIONS_BASE_URL}/confirmPhoneVerification`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${idToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    organizationId: orgDocId,
                    phoneNumber: phoneInput.trim(),
                }),
            });

            const data = await response.json().catch(() => ({}));
            if (response.ok && data.success) {
                Alert.alert(
                    data.autoApproved ? 'Verified!' : 'Phone Confirmed',
                    data.autoApproved
                        ? 'Your organization has been approved!'
                        : `Phone verified! Score: ${data.totalScore} points.`
                );
                setShowPhoneVerify(false);
                if (data.autoApproved) {
                    await refreshProfile();
                }
            } else {
                Alert.alert('Error', data.error || 'Failed to verify phone');
            }
        } catch (error) {
            logger.error('Error verifying phone:', error);
            Alert.alert('Error', 'Failed to verify phone');
        } finally {
            setPhoneVerifying(false);
        }
    };

    const getCheckIcon = (status: string) => {
        if (status === 'passed') return { name: 'check-circle' as const, color: theme.colors.success };
        if (status === 'failed') return { name: 'close-circle' as const, color: theme.colors.error };
        if (status === 'pending') return { name: 'clock-outline' as const, color: theme.colors.verificationPending };
        return { name: 'minus-circle-outline' as const, color: theme.colors.gray };
    };

    return (
        <ScrollView
            contentContainerStyle={styles.container}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
        >
            <MaterialCommunityIcons name="shield-lock-outline" size={80} color={theme.colors.verificationPending} />

            <Text style={styles.title}>ORGANIZATION UNDER REVIEW</Text>

            <Text style={styles.message}>
                Your organization{user?.organizationName ? ` "${user.organizationName}"` : ''} is being verified.
            </Text>

            <Text style={styles.instruction}>
                If your organization isn't approved automatically, a HolyGuard administrator will review it. You can add details below to speed things up. This screen moves on by itself once a decision is made.
            </Text>

            {/* Verification Checks Card */}
            {loadingChecks ? (
                <ActivityIndicator size="small" color={theme.colors.primary} style={{ marginVertical: 20 }} />
            ) : verificationChecks ? (
                <View style={styles.checksCard}>
                    <Text style={styles.checksTitle}>Verification Status</Text>

                    {CHECK_ROWS.map(({ key, label }) => {
                        const check = verificationChecks[key];
                        const icon = getCheckIcon(check?.status || 'skipped');
                        const canVerify = check?.status === 'pending' || check?.status === 'skipped';
                        return (
                            <View key={key} style={styles.checkRow}>
                                <MaterialCommunityIcons name={icon.name} size={20} color={icon.color} />
                                <Text style={styles.checkLabel}>{label}</Text>
                                <Text style={[styles.checkScore, { color: icon.color }]}>
                                    {check?.score || 0} pts
                                </Text>
                                {canVerify && key === 'phoneSms' && (
                                    <TouchableOpacity
                                        style={styles.verifyNowBtn}
                                        onPress={() => setShowPhoneVerify(!showPhoneVerify)}
                                    >
                                        <Text style={styles.verifyNowText}>VERIFY</Text>
                                    </TouchableOpacity>
                                )}
                            </View>
                        );
                    })}

                    <View style={styles.scoreDivider} />
                    <View style={styles.checkRow}>
                        <MaterialCommunityIcons name="sigma" size={20} color={theme.colors.textPrimary} />
                        <Text style={[styles.checkLabel, { fontWeight: 'bold' }]}>Total Score</Text>
                        <Text style={[styles.checkScore, { fontWeight: 'bold', color: theme.colors.textPrimary }]}>
                            {verificationChecks.totalScore || 0} pts
                        </Text>
                    </View>
                    <Text style={styles.thresholdNote}>
                        60 points approves an organization automatically. Otherwise an administrator reviews it.
                    </Text>
                </View>
            ) : orgDocId ? (
                <View style={styles.checksCard}>
                    <Text style={styles.checksTitle}>Verification Status</Text>
                    <Text style={styles.inlineSubtext}>
                        The automated checks haven't run for your organization yet.
                    </Text>
                    <TouchableOpacity
                        style={styles.inlineButton}
                        onPress={handleRunChecks}
                        disabled={runningChecks || !orgData}
                    >
                        {runningChecks ? (
                            <ActivityIndicator color={theme.colors.textPrimary} />
                        ) : (
                            <Text style={styles.inlineButtonText}>RUN VERIFICATION CHECKS</Text>
                        )}
                    </TouchableOpacity>
                </View>
            ) : null}

            {/* Phone Verification Inline */}
            {showPhoneVerify && (
                <View style={styles.inlineVerifyCard}>
                    <Text style={styles.inlineTitle}>Verify Organization Phone</Text>
                    <Text style={styles.inlineSubtext}>
                        Enter your organization's phone number
                    </Text>
                    <TextInput
                        style={styles.inlineInput}
                        value={phoneInput}
                        onChangeText={setPhoneInput}
                        placeholder="(555) 123-4567"
                        placeholderTextColor={theme.colors.gray}
                        keyboardType="phone-pad"
                    />
                    <TouchableOpacity
                        style={styles.inlineButton}
                        onPress={handlePhoneVerify}
                        disabled={phoneVerifying}
                    >
                        {phoneVerifying ? (
                            <ActivityIndicator color={theme.colors.textPrimary} />
                        ) : (
                            <Text style={styles.inlineButtonText}>VERIFY PHONE</Text>
                        )}
                    </TouchableOpacity>
                </View>
            )}

            <TouchableOpacity
                style={styles.checkButton}
                onPress={handleCheckStatus}
                disabled={checking}
            >
                {checking ? (
                    <ActivityIndicator color={theme.colors.white} />
                ) : (
                    <Text style={styles.buttonText}>CHECK STATUS</Text>
                )}
            </TouchableOpacity>

            <AccountActions style={styles.accountActions} />
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flexGrow: 1,
        backgroundColor: theme.colors.background,
        padding: theme.spacing.l,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        fontSize: 22,
        fontWeight: '900',
        color: theme.colors.textPrimary,
        marginTop: 20,
        letterSpacing: 1,
        textAlign: 'center',
    },
    message: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginTop: 12,
        textAlign: 'center',
    },
    instruction: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 8,
        marginBottom: 20,
        paddingHorizontal: 20,
        lineHeight: 20,
    },
    checksCard: {
        backgroundColor: theme.colors.white,
        borderRadius: 12,
        padding: 16,
        width: '100%',
        borderWidth: 1,
        borderColor: theme.colors.border,
        marginBottom: 16,
    },
    checksTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: theme.colors.textPrimary,
        marginBottom: 12,
    },
    checkRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
    },
    checkLabel: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.textPrimary,
        marginLeft: 10,
    },
    checkScore: {
        fontSize: 14,
        fontWeight: '600',
        marginRight: 8,
    },
    verifyNowBtn: {
        backgroundColor: theme.colors.primary,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
    },
    verifyNowText: {
        color: theme.colors.textPrimary,
        fontSize: 11,
        fontWeight: 'bold',
        letterSpacing: 0.5,
    },
    scoreDivider: {
        height: 1,
        backgroundColor: theme.colors.border,
        marginVertical: 6,
    },
    thresholdNote: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 6,
        fontStyle: 'italic',
    },
    inlineVerifyCard: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 16,
        width: '100%',
        borderWidth: 1,
        borderColor: theme.colors.primary,
        marginBottom: 16,
    },
    inlineTitle: {
        fontSize: 15,
        fontWeight: 'bold',
        color: theme.colors.textPrimary,
        marginBottom: 6,
    },
    inlineSubtext: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 12,
    },
    inlineInput: {
        backgroundColor: theme.colors.white,
        padding: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        fontSize: 16,
        color: theme.colors.textPrimary,
        marginBottom: 12,
    },
    inlineButton: {
        backgroundColor: theme.colors.primary,
        padding: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    inlineButtonText: {
        color: theme.colors.textPrimary,
        fontWeight: 'bold',
        fontSize: 14,
        letterSpacing: 0.5,
    },
    checkButton: {
        backgroundColor: theme.colors.success,
        paddingVertical: 16,
        paddingHorizontal: 32,
        borderRadius: 8,
        width: '100%',
        alignItems: 'center',
        marginBottom: 15,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 3,
    },
    buttonText: {
        color: theme.colors.white,
        fontWeight: 'bold',
        fontSize: 16,
        letterSpacing: 1,
    },
    accountActions: {
        marginTop: 10,
    },
});
