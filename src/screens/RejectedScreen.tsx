import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking, Alert, ScrollView } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { theme } from '../theme';
import { useAuth } from '../context/AuthContext';
import { db } from '../config/firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { logger } from '../utils/logger';
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from '../constants/links';
import { AccountActions } from '../components/AccountActions';

export const RejectedScreen = () => {
    const { user } = useAuth();
    const [rejectionReason, setRejectionReason] = useState<string>('');

    useEffect(() => {
        const loadRejectionReason = async () => {
            if (!user?.organizationId || user.organizationId === 'default-org') return;

            try {
                const orgsQuery = query(collection(db, 'organizations'), where('id', '==', user.organizationId));
                const orgSnapshot = await getDocs(orgsQuery);
                if (!orgSnapshot.empty) {
                    const orgData = orgSnapshot.docs[0].data();
                    setRejectionReason(orgData.rejectionReason || '');
                }
            } catch (error) {
                logger.error('Error loading rejection reason:', error);
            }
        };

        loadRejectionReason();
    }, [user?.organizationId]);

    const handleContactSupport = async () => {
        const subject = `Organization Review Appeal${user?.organizationName ? `: ${user.organizationName}` : ''}`;
        const url = `${SUPPORT_MAILTO}?subject=${encodeURIComponent(subject)}`;
        try {
            await Linking.openURL(url);
        } catch (error) {
            // No mail app set up on this device.
            logger.error('Could not open the mail app:', error);
            Alert.alert('Contact Support', `Email us at ${SUPPORT_EMAIL} to appeal this decision.`);
        }
    };

    return (
        // Scrolls so a long rejection reason can't push Sign Out / Delete Account off screen.
        <ScrollView contentContainerStyle={styles.container}>
            <MaterialCommunityIcons name="shield-off-outline" size={80} color={theme.colors.verificationRejected} />

            <Text style={styles.title}>ORGANIZATION NOT APPROVED</Text>

            <Text style={styles.message}>
                Your organization{user?.organizationName ? ` "${user.organizationName}"` : ''} did not pass verification.
            </Text>

            {rejectionReason ? (
                <View style={styles.reasonCard}>
                    <Text style={styles.reasonLabel}>Reason:</Text>
                    <Text style={styles.reasonText}>{rejectionReason}</Text>
                </View>
            ) : null}

            <Text style={styles.instruction}>
                If you believe this is an error, contact our support team at {SUPPORT_EMAIL} to appeal this decision.
            </Text>

            <TouchableOpacity style={styles.contactButton} onPress={handleContactSupport}>
                <MaterialCommunityIcons name="email-outline" size={20} color={theme.colors.textPrimary} style={{ marginRight: 8 }} />
                <Text style={styles.contactButtonText}>CONTACT SUPPORT</Text>
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
    reasonCard: {
        backgroundColor: theme.colors.white,
        borderRadius: 12,
        padding: 16,
        width: '100%',
        borderWidth: 1,
        borderColor: theme.colors.verificationRejected,
        marginTop: 20,
    },
    reasonLabel: {
        fontSize: 13,
        fontWeight: 'bold',
        color: theme.colors.verificationRejected,
        marginBottom: 6,
    },
    reasonText: {
        fontSize: 15,
        color: theme.colors.textPrimary,
        lineHeight: 22,
    },
    instruction: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 20,
        marginBottom: 30,
        paddingHorizontal: 20,
        lineHeight: 20,
    },
    contactButton: {
        backgroundColor: theme.colors.primary,
        paddingVertical: 16,
        paddingHorizontal: 32,
        borderRadius: 8,
        width: '100%',
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        marginBottom: 15,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 3,
    },
    contactButtonText: {
        color: theme.colors.textPrimary,
        fontWeight: 'bold',
        fontSize: 16,
        letterSpacing: 1,
    },
    accountActions: {
        marginTop: 20,
    },
});
