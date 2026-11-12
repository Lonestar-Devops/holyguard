import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { theme } from '../theme';
import { auth } from '../config/firebase';
import { signInWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth';
import { validateEmail } from '../utils/validation';
import { logger } from '../utils/logger';

export const LoginScreen = ({ navigation }: any) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [sendingReset, setSendingReset] = useState(false);

    const handleLogin = async () => {
        const trimmedEmail = email.trim();
        if (!trimmedEmail || !password) {
            Alert.alert("Error", "Please fill in all fields");
            return;
        }

        // Validate email format
        const emailValidation = validateEmail(trimmedEmail);
        if (!emailValidation.valid) {
            Alert.alert("Invalid Email", emailValidation.error || 'Please enter a valid email');
            return;
        }

        setLoading(true);
        try {
            await signInWithEmailAndPassword(auth, trimmedEmail, password);
            // AuthContext will automatically redirect
        } catch (error: any) {
            if (error?.code === 'auth/network-request-failed') {
                Alert.alert("Login Failed", "Network error. Please check your connection and try again.");
            } else if (error?.code === 'auth/too-many-requests') {
                Alert.alert("Login Failed", "Too many attempts. Please wait a few minutes, or reset your password.");
            } else {
                Alert.alert("Login Failed", "Invalid email or password. Please try again.");
            }
            setLoading(false);
        }
    };

    const sendResetLink = async (address: string) => {
        setSendingReset(true);
        try {
            await sendPasswordResetEmail(auth, address);
            showResetSent(address);
        } catch (error: any) {
            switch (error?.code) {
                case 'auth/user-not-found':
                    // Same answer as a real account, so this can't be used to probe for accounts.
                    showResetSent(address);
                    break;
                case 'auth/invalid-email':
                    Alert.alert("Invalid Email", "Please enter a valid email address.");
                    break;
                case 'auth/network-request-failed':
                    Alert.alert("Network Error", "Please check your connection and try again.");
                    break;
                case 'auth/too-many-requests':
                    Alert.alert("Too Many Requests", "Please wait a few minutes before requesting another reset link.");
                    break;
                default:
                    logger.error('Password reset failed:', error);
                    Alert.alert("Error", "We couldn't send a reset link right now. Please try again later.");
            }
        } finally {
            setSendingReset(false);
        }
    };

    const showResetSent = (address: string) => {
        Alert.alert(
            "Check Your Email",
            `If an account exists for ${address}, we've sent a link to reset your password. Check your spam folder if it doesn't arrive in a few minutes.`
        );
    };

    const handleForgotPassword = () => {
        const trimmedEmail = email.trim();
        if (!trimmedEmail) {
            Alert.alert("Enter Your Email", "Type the email address you sign in with above, then tap \"Forgot password?\" again.");
            return;
        }
        const emailValidation = validateEmail(trimmedEmail);
        if (!emailValidation.valid) {
            Alert.alert("Invalid Email", emailValidation.error || 'Please enter a valid email');
            return;
        }
        Alert.alert(
            "Reset Password",
            `Send a password reset link to ${trimmedEmail}?`,
            [
                { text: "Cancel", style: "cancel" },
                { text: "Send Link", onPress: () => { sendResetLink(trimmedEmail); } },
            ]
        );
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>HOLYGUARD</Text>
                <Text style={styles.subtitle}>SECURE NETWORK ACCESS</Text>
            </View>

            <View style={styles.form}>
                <Text style={styles.label}>EMAIL</Text>
                <TextInput 
                    style={styles.input} 
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    value={email}
                    onChangeText={setEmail}
                    placeholder="officer@church.org"
                    placeholderTextColor={theme.colors.gray}
                />

                <Text style={styles.label}>PASSWORD</Text>
                <TextInput 
                    style={styles.input} 
                    secureTextEntry
                    value={password}
                    onChangeText={setPassword}
                    placeholder="••••••••"
                    placeholderTextColor={theme.colors.gray}
                />

                <TouchableOpacity
                    onPress={handleForgotPassword}
                    disabled={sendingReset || loading}
                    style={styles.forgotContainer}
                >
                    {sendingReset ? (
                        <ActivityIndicator size="small" color={theme.colors.primary} />
                    ) : (
                        <Text style={styles.forgotText}>Forgot password?</Text>
                    )}
                </TouchableOpacity>

                <TouchableOpacity 
                    style={styles.button} 
                    onPress={handleLogin}
                    disabled={loading}
                >
                    {loading ? (
                        <ActivityIndicator color={theme.colors.textPrimary} />
                    ) : (
                        <Text style={styles.buttonText}>AUTHENTICATE</Text>
                    )}
                </TouchableOpacity>

                <TouchableOpacity onPress={() => navigation.navigate('SignUp')} style={styles.linkContainer}>
                    <Text style={styles.linkText}>First time? <Text style={styles.linkHighlight}>Activate Access</Text></Text>
                </TouchableOpacity>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
        padding: theme.spacing.l,
        justifyContent: 'center',
    },
    header: {
        alignItems: 'center',
        marginBottom: 60,
    },
    title: {
        fontSize: 32,
        fontWeight: '900',
        color: theme.colors.textPrimary,
        letterSpacing: 2,
    },
    subtitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: theme.colors.primary,
        letterSpacing: 1,
        marginTop: 8,
    },
    form: {
        width: '100%',
    },
    label: {
        fontSize: 12,
        fontWeight: 'bold',
        color: theme.colors.textSecondary,
        marginBottom: 8,
        letterSpacing: 0.5,
    },
    input: {
        backgroundColor: theme.colors.white,
        padding: 16,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        marginBottom: 20,
        fontSize: 16,
        color: theme.colors.textPrimary,
    },
    forgotContainer: {
        alignSelf: 'flex-end',
        marginTop: -12,
        marginBottom: 12,
        paddingVertical: 4,
        minHeight: 24,
        justifyContent: 'center',
    },
    forgotText: {
        color: theme.colors.primary,
        fontSize: 14,
        fontWeight: '600',
    },
    button: {
        backgroundColor: theme.colors.primary,
        padding: 16,
        borderRadius: 8,
        alignItems: 'center',
        marginTop: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 3,
    },
    buttonText: {
        color: theme.colors.textPrimary,
        fontWeight: 'bold',
        fontSize: 16,
        letterSpacing: 1,
    },
    linkContainer: {
        marginTop: 24,
        alignItems: 'center',
    },
    linkText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
    },
    linkHighlight: {
        color: theme.colors.primary,
        fontWeight: 'bold',
    }
});
