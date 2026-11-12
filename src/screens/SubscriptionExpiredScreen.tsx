import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { theme } from '../theme';
import { useAuth } from '../context/AuthContext';
import { AccountActions } from '../components/AccountActions';
import { SUPPORT_EMAIL } from '../constants/links';
import { logger } from '../utils/logger';

// Shown by RootNavigator to non-admins whose org has no active subscription, and to anyone
// whose account is no longer part of an org: AuthContext reports organizationId
// 'default-org' when the profile's organization_id is 'removed' (Seat Management → Remove),
// '' or missing.
export const SubscriptionExpiredScreen = () => {
    const { user, refreshProfile } = useAuth();
    const [checking, setChecking] = useState(false);
    const noOrganization = !user?.organizationId || user.organizationId === 'default-org';

    const handleCheckAgain = async () => {
        if (checking) return;
        setChecking(true);
        try {
            await refreshProfile();
        } catch (error) {
            logger.warn('Check Again failed:', error);
        } finally {
            setChecking(false);
        }
    };

    return (
        <ScrollView contentContainerStyle={styles.container}>
            <MaterialCommunityIcons
                name={noOrganization ? 'account-off-outline' : 'shield-off-outline'}
                size={64}
                color={theme.colors.textSecondary}
            />

            <Text style={styles.title}>{noOrganization ? 'NO ORGANIZATION' : 'SUBSCRIPTION EXPIRED'}</Text>

            {noOrganization ? (
                // An existing account can't enter an invite code (codes are only used at sign-up),
                // so support is the way back in with this account.
                <Text style={styles.message}>
                    Your account is no longer part of an organization. If you should still have access, ask an
                    organization admin for a new invite, then email {SUPPORT_EMAIL} for help rejoining with this account.
                </Text>
            ) : (
                <Text style={styles.message}>
                    Your organization's subscription has expired. Please contact your administrator to renew the subscription.
                </Text>
            )}

            {!noOrganization && !!user?.organizationName && (
                <View style={styles.orgCard}>
                    <MaterialCommunityIcons name="church" size={24} color={theme.colors.primary} />
                    <Text style={styles.orgName}>{user.organizationName}</Text>
                </View>
            )}

            <TouchableOpacity
                style={[styles.refreshButton, checking && styles.refreshButtonDisabled]}
                onPress={handleCheckAgain}
                disabled={checking}
                accessibilityRole="button"
                accessibilityState={{ disabled: checking, busy: checking }}
            >
                {checking ? (
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                ) : (
                    <MaterialCommunityIcons name="refresh" size={20} color={theme.colors.primary} />
                )}
                <Text style={styles.refreshText}>Check Again</Text>
            </TouchableOpacity>

            <AccountActions />
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flexGrow: 1,
        backgroundColor: theme.colors.background,
        justifyContent: 'center',
        alignItems: 'center',
        padding: theme.spacing.l,
    },
    title: {
        fontSize: 22,
        fontWeight: '900',
        color: theme.colors.textPrimary,
        letterSpacing: 2,
        marginTop: 20,
        marginBottom: 12,
        textAlign: 'center',
    },
    message: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 20,
        paddingHorizontal: 20,
        marginBottom: 24,
        maxWidth: 480,
    },
    orgCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.white,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        marginBottom: 24,
    },
    orgName: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.textPrimary,
        marginLeft: 10,
    },
    refreshButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.primary,
        marginBottom: 16,
    },
    refreshButtonDisabled: {
        opacity: 0.6,
    },
    refreshText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.primary,
        marginLeft: 8,
    },
});
