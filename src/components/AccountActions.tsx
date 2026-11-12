import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Alert, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { useAuth } from '../context/AuthContext';
import { DeleteAccountModal } from './DeleteAccountModal';
import { logger } from '../utils/logger';

interface AccountActionsProps {
    style?: any;
}

/**
 * 'Sign Out' and 'Delete Account' for the gate screens (paywall, subscription expired,
 * pending approval, ...), so a user who can't get into the app can still leave it or
 * delete their account (App Store Guideline 5.1.1(v)).
 */
export const AccountActions: React.FC<AccountActionsProps> = ({ style }) => {
    const { logout } = useAuth();
    const [showDelete, setShowDelete] = useState(false);
    const [signingOut, setSigningOut] = useState(false);

    const handleSignOut = async () => {
        if (signingOut) return;
        setSigningOut(true);
        try {
            await logout();
        } catch (error) {
            logger.error('Sign out failed:', error);
            Alert.alert('Sign Out Failed', 'Please try again.');
            setSigningOut(false);
        }
    };

    return (
        <View style={[styles.container, style]}>
            <TouchableOpacity
                onPress={handleSignOut}
                disabled={signingOut}
                style={styles.action}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityState={{ disabled: signingOut }}
            >
                <Text style={[styles.signOutText, signingOut && styles.disabledText]}>Sign Out</Text>
            </TouchableOpacity>
            <Text style={styles.separator}>·</Text>
            <TouchableOpacity
                onPress={() => setShowDelete(true)}
                disabled={signingOut}
                style={styles.action}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityState={{ disabled: signingOut }}
            >
                <Text style={[styles.deleteText, signingOut && styles.disabledText]}>Delete Account</Text>
            </TouchableOpacity>
            <DeleteAccountModal visible={showDelete} onClose={() => setShowDelete(false)} />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 8,
    },
    action: {
        paddingVertical: 8,
        paddingHorizontal: 4,
    },
    separator: {
        fontSize: 14,
        color: theme.colors.gray,
        marginHorizontal: 10,
    },
    signOutText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    deleteText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.danger,
    },
    disabledText: {
        opacity: 0.5,
    },
});
