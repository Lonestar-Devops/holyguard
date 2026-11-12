import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, Linking } from 'react-native';
import { logger } from '../utils/logger';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { theme } from '../theme';
import { auth, db } from '../config/firebase';
import { createUserWithEmailAndPassword, sendEmailVerification, deleteUser, signOut, type User } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, collection, addDoc } from 'firebase/firestore';
import { validateEmail, validatePassword } from '../utils/validation';
import { GooglePlacesAutocomplete } from 'react-native-google-places-autocomplete';
import { GOOGLE_PLACES_API_KEY } from '../config/keys';
import { useAuth, beginSignUp, endSignUp } from '../context/AuthContext';
import { TERMS_URL, PRIVACY_URL, FUNCTIONS_BASE_URL, SUPPORT_EMAIL } from '../constants/links';

const formatEIN = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 9);
    if (digits.length > 2) {
        return `${digits.slice(0, 2)}-${digits.slice(2)}`;
    }
    return digits;
};

const totalSteps = (creatingOrg: boolean) => creatingOrg ? 4 : 3;

// How long sign-up waits for the automated organization checks before moving on. The
// checks keep running on the server; the Pending screen shows their results later.
const VERIFY_ORG_TIMEOUT_MS = 20000;

// Verification checks shown after sign-up. The organization email check is left out: its
// code is never delivered, so it can't be completed.
const VERIFICATION_CHECK_LABELS: Array<{ key: string; label: string }> = [
    { key: 'googlePlaces', label: 'Google Places' },
    { key: 'einVerification', label: 'EIN / 501(c)(3)' },
    { key: 'phoneSms', label: 'Phone' },
];

type InviteCodeResult = {
    valid: boolean;
    role: string;
    organizationId: string;
    organizationName: string;
    error?: string;
};

// A sign-up step failed and has been rolled back; message is safe to show as is.
const SIGN_UP_ABANDONED = 'signup-abandoned';

const abandonedError = (message: string) => {
    const error: any = new Error(message);
    error.code = SIGN_UP_ABANDONED;
    return error;
};

const describeSignUpError = (error: any): string => {
    if (error?.code === SIGN_UP_ABANDONED) return error.message;
    switch (error?.code) {
        case 'auth/email-already-in-use':
            return 'This email is already registered. Please log in instead.';
        case 'auth/invalid-email':
            return 'Please enter a valid email address.';
        case 'auth/weak-password':
            return 'Please choose a stronger password.';
        case 'auth/network-request-failed':
            return 'Network error. Please check your connection and try again.';
        case 'auth/too-many-requests':
            return 'Too many attempts. Please wait a few minutes and try again.';
        default:
            return 'Unable to complete registration. Please try again.';
    }
};

// true / false when we could tell whether users/{uid} exists, null when we couldn't.
const profileExists = async (uid: string): Promise<boolean | null> => {
    try {
        const snapshot = await getDoc(doc(db, 'users', uid));
        return snapshot.exists();
    } catch (error) {
        logger.error('Could not check for the new profile:', error);
        return null;
    }
};

// Undo a sign-up that failed before its profile existed, so the person isn't left with an
// Auth account that has no profile (which can't sign up again with the same email and
// can't reach the app). Removes the Auth account when the profile is confirmed missing;
// otherwise just signs out. Returns the message to show.
const rollBackSignUp = async (user: User): Promise<string> => {
    const exists = await profileExists(user.uid);
    if (exists === false) {
        try {
            await deleteUser(user);
            return "We couldn't finish setting up your account, so nothing was saved. Please check your connection and try again.";
        } catch (error) {
            logger.error('Could not remove the incomplete account:', error);
        }
    }
    try {
        await signOut(auth);
    } catch (error) {
        logger.error('Could not sign out after a failed sign-up:', error);
    }
    return `We couldn't finish setting up your account. Please check your connection and try again. If this email now shows as already registered, contact ${SUPPORT_EMAIL} and we'll sort it out.`;
};

// Creates users/{uid} through the Firestore REST API (a POST with documentId creates the
// doc and fails if it already exists). Every sign-up writes exactly these 8 fields.
// Invite joins pass role '' and organizationId '': the rules let a new profile claim only
// a freshly minted org id, and the repairInviteJoin trigger attaches the user to the
// invite's org only for this exact shape (functions/inviteJoinRepair.js).
const writeSignUpProfile = async (
    user: User,
    profile: { name: string; email: string; role: '' | 'admin'; organizationId: string },
) => {
    const idToken = await user.getIdToken();
    const url = `https://firestore.googleapis.com/v1/projects/holyguard-app/databases/(default)/documents/users?documentId=${user.uid}`;
    const now = new Date().toISOString();

    const firestoreDoc = {
        fields: {
            id: { stringValue: user.uid },
            name: { stringValue: profile.name },
            email: { stringValue: profile.email },
            role: { stringValue: profile.role },
            organization_id: { stringValue: profile.organizationId },
            email_verified: { booleanValue: false },
            created_at: { timestampValue: now },
            tos_accepted_at: { timestampValue: now },
        }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${idToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(firestoreDoc),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Failed to create user profile (${response.status}): ${errorText}`);
    }
};

// Writes the profile; if that fails and the profile really isn't there, rolls the sign-up
// back and throws a displayable error.
const writeProfileOrRollBack = async (
    user: User,
    profile: { name: string; email: string; role: '' | 'admin'; organizationId: string },
) => {
    try {
        await writeSignUpProfile(user, profile);
    } catch (profileError) {
        logger.error('Profile creation failed:', profileError);
        // The write may have landed even though the response was lost.
        if ((await profileExists(user.uid)) === true) return;
        throw abandonedError(await rollBackSignUp(user));
    }
};

export const SignUpScreen = ({ navigation }: any) => {
    const { refreshProfile } = useAuth();
    const [step, setStep] = useState(1);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [inviteCode, setInviteCode] = useState('');
    const [joiningExistingOrg, setJoiningExistingOrg] = useState(true);
    const [churchName, setChurchName] = useState('');
    const [churchAddress, setChurchAddress] = useState('');
    const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
    const [loading, setLoading] = useState(false);
    // Display only: the org a just-validated invite code belongs to.
    const [validatedOrgName, setValidatedOrgName] = useState<string>('');
    const placesRef = useRef<any>(null);
    const [tosAccepted, setTosAccepted] = useState(false);

    // New verification fields
    const [ein, setEin] = useState('');
    const [website, setWebsite] = useState('');
    const [orgPhone, setOrgPhone] = useState('');
    const [verifying, setVerifying] = useState(false);
    const [verificationResults, setVerificationResults] = useState<any>(null);
    const [finishing, setFinishing] = useState(false);

    // Sign-up hold bookkeeping (see beginSignUp in AuthContext).
    const mounted = useRef(true);
    const holdActive = useRef(false);   // this screen began a sign-up hold that is still on
    const flowRunning = useRef(false);  // a sign-up request sequence is in flight

    const startHold = () => {
        beginSignUp();
        holdActive.current = true;
    };

    const releaseHold = () => {
        if (holdActive.current) {
            holdActive.current = false;
            endSignUp();
        }
    };

    // Success: load the new profile, which ends the hold and moves on to the next screen.
    const finishSignUp = async () => {
        holdActive.current = false;
        await refreshProfile();
    };

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            // Leaving while the results step is up: let the app load the new account. A
            // sequence still in flight releases the hold itself when it ends.
            if (!flowRunning.current) {
                releaseHold();
            }
        };
    }, []);

    // No swipe-back while account requests are in flight or the results step is up.
    useEffect(() => {
        navigation?.setOptions?.({ gestureEnabled: !(loading || step === 4) });
    }, [navigation, loading, step]);

    const selectJoinMode = (joining: boolean) => {
        setJoiningExistingOrg(joining);
        setValidatedOrgName('');
    };

    const validateInviteCode = async (code: string): Promise<InviteCodeResult> => {
        try {
            const response = await fetch(`${FUNCTIONS_BASE_URL}/validateInviteCode`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ inviteCode: code }),
            });

            const data = await response.json();
            return {
                valid: data.valid || false,
                role: data.role || 'member',
                organizationId: data.organizationId || '',
                organizationName: data.organizationName || '',
                error: data.error
            };
        } catch (error) {
            return { valid: false, role: 'member', organizationId: '', organizationName: '', error: 'Network error. Please check your connection and try again.' };
        }
    };

    const handleStep1Next = async () => {
        if (!name.trim() || !email.trim() || !password) {
            Alert.alert("Error", "Please fill in all fields.");
            return;
        }

        const emailValidation = validateEmail(email.trim());
        if (!emailValidation.valid) {
            Alert.alert("Invalid Email", emailValidation.error || 'Please enter a valid email');
            return;
        }

        const passwordValidation = validatePassword(password);
        if (!passwordValidation.valid) {
            Alert.alert("Weak Password", passwordValidation.error || 'Please use a stronger password');
            return;
        }

        if (!tosAccepted) {
            Alert.alert("Terms Required", "You must agree to the Terms of Service and Privacy Policy to continue.");
            return;
        }

        setStep(2);
    };

    const handleStep2Next = async () => {
        // A second tap before the button disables must not validate the code (and use up
        // an invite use) again, or start a second account sequence.
        if (flowRunning.current) return;
        if (joiningExistingOrg) {
            if (!inviteCode.trim()) {
                Alert.alert("Error", "Please enter an invite code.");
                return;
            }

            setLoading(true);
            flowRunning.current = true;
            const result = await validateInviteCode(inviteCode.trim());

            if (!result.valid) {
                flowRunning.current = false;
                setLoading(false);
                Alert.alert("Invalid Code", result.error || 'This invite code is not valid.');
                return;
            }

            setValidatedOrgName(result.organizationName);
            await handleJoinExistingOrg(result);
        } else {
            setValidatedOrgName('');
            setStep(3);
        }
    };

    // Invite join. The profile is created org-less (role '' and organization_id ''); the
    // repairInviteJoin trigger attaches it to the invite's org from the join intent that
    // validateInviteCode just recorded.
    const handleJoinExistingOrg = async (invite: InviteCodeResult) => {
        setLoading(true);
        flowRunning.current = true;
        startHold();
        let finished = false;
        try {
            const trimmedEmail = email.trim();
            const userCredential = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
            const user = userCredential.user;

            await writeProfileOrRollBack(user, {
                name: name.trim(),
                email: trimmedEmail,
                role: '',
                organizationId: '',
            });

            try {
                await sendEmailVerification(user);
            } catch (emailError) {
                // The next screen has a Resend button.
                logger.error('Could not send the verification email:', emailError);
            }

            finished = true;
            await finishSignUp();

            Alert.alert(
                invite.organizationName ? `Welcome to ${invite.organizationName}` : 'Welcome to HolyGuard',
                `We sent a verification link to ${trimmedEmail}. Tap it, then come back to the app.`
            );
        } catch (error: any) {
            logger.error('Invite sign-up failed:', error);
            Alert.alert("Registration Failed", describeSignUpError(error));
        } finally {
            flowRunning.current = false;
            if (!finished) releaseHold();
            if (mounted.current) setLoading(false);
        }
    };

    // Runs the automated organization checks. Never throws: a failure or timeout leaves
    // the org pending, and the Pending screen can run the checks again.
    const runOrganizationChecks = async (user: User, orgDocId: string) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), VERIFY_ORG_TIMEOUT_MS);
        try {
            const idToken = await user.getIdToken();
            const verifyResponse = await fetch(`${FUNCTIONS_BASE_URL}/verifyOrganization`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${idToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    organizationId: orgDocId,
                    ein: ein ? ein.replace(/\D/g, '') : undefined,
                    phone: orgPhone.trim() || undefined,
                    website: website.trim() || undefined,
                }),
                signal: controller.signal,
            });
            const verifyResult = await verifyResponse.json();
            if (!verifyResponse.ok) {
                throw new Error(verifyResult?.error || `verifyOrganization returned ${verifyResponse.status}`);
            }
            return verifyResult;
        } catch (verifyError) {
            logger.error('Verification call failed:', verifyError);
            return { status: 'pending', score: 0, checks: {}, incomplete: true };
        } finally {
            clearTimeout(timer);
        }
    };

    // New organization. Order matters for the security rules: the org first (any signed-in
    // user may create a pending org with a fresh id), then the admin profile that claims it,
    // then #general (only an admin of the org may create its channels).
    const handleCompleteSignup = async () => {
        if (flowRunning.current) return;
        if (!churchName.trim()) {
            Alert.alert("Error", "Please enter your church or organization name.");
            return;
        }

        if (!churchAddress || !coordinates) {
            Alert.alert("Error", "Please select an address from the dropdown suggestions.");
            return;
        }

        setLoading(true);
        flowRunning.current = true;
        startHold();
        let reachedResults = false;
        try {
            const trimmedEmail = email.trim();

            // 1. Create Auth User
            const userCredential = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
            const user = userCredential.user;

            // 2. Create organization with pending status
            const orgId = `org_${Date.now()}`;
            let orgDocId: string;
            try {
                const orgDocRef = await addDoc(collection(db, 'organizations'), {
                    id: orgId,
                    name: churchName.trim(),
                    address: churchAddress,
                    latitude: coordinates.latitude,
                    longitude: coordinates.longitude,
                    status: 'pending',
                    ein: ein ? ein.replace(/\D/g, '') : null,
                    website: website.trim() || null,
                    phone: orgPhone.trim() || null,
                    verificationScore: 0,
                    verificationSubmittedAt: serverTimestamp(),
                    created_at: serverTimestamp(),
                });
                orgDocId = orgDocRef.id;
            } catch (orgError) {
                logger.error('Organization creation failed:', orgError);
                throw abandonedError(await rollBackSignUp(user));
            }

            // 3. Create the admin profile that owns the new org
            await writeProfileOrRollBack(user, {
                name: name.trim(),
                email: trimmedEmail,
                role: 'admin',
                organizationId: orgId,
            });

            // 4. Create default #general channel. Not fatal: the admin can add channels later.
            try {
                await addDoc(collection(db, 'channels'), {
                    name: 'general',
                    organizationId: orgId,
                    createdBy: user.uid,
                    createdAt: serverTimestamp(),
                    isDefault: true,
                });
            } catch (channelError) {
                logger.error('Could not create the #general channel:', channelError);
            }

            // 5. Send Email Verification (the next screen has a Resend button)
            try {
                await sendEmailVerification(user);
            } catch (emailError) {
                logger.error('Could not send the verification email:', emailError);
            }

            // 6. Show the verification step while the automated checks run
            if (mounted.current) {
                setStep(4);
                setVerifying(true);
                setLoading(false);
            }

            const verifyResult = await runOrganizationChecks(user, orgDocId);
            if (mounted.current) {
                setVerificationResults(verifyResult);
                setVerifying(false);
            }
            reachedResults = true;
        } catch (error: any) {
            logger.error('New organization sign-up failed:', error);
            Alert.alert("Registration Failed", describeSignUpError(error));
        } finally {
            flowRunning.current = false;
            // On success the results stay up until CONTINUE; if the screen is already gone,
            // let the app load the new account now.
            if (!reachedResults || !mounted.current) releaseHold();
            if (mounted.current) setLoading(false);
        }
    };

    const handleContinueAfterVerification = async () => {
        setFinishing(true);
        try {
            await finishSignUp();
        } finally {
            if (mounted.current) setFinishing(false);
        }
    };

    const getStepTitle = () => {
        if (step === 1) return 'CREATE ACCOUNT';
        if (step === 2) return 'JOIN ORGANIZATION';
        if (step === 3) return 'ORGANIZATION INFO';
        if (step === 4) return 'VERIFICATION';
        return '';
    };

    const getStepSubtitle = () => {
        const total = totalSteps(!joiningExistingOrg);
        return `STEP ${step} OF ${total}`;
    };

    const getCheckIcon = (status: string) => {
        if (status === 'passed') return { name: 'check-circle' as const, color: theme.colors.success };
        if (status === 'failed') return { name: 'close-circle' as const, color: theme.colors.error };
        if (status === 'pending') return { name: 'clock-outline' as const, color: theme.colors.verificationPending };
        return { name: 'minus-circle-outline' as const, color: theme.colors.gray };
    };

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            style={styles.container}
        >
            {/* 'handled' on this outer ScrollView too: a nested ScrollView's setting only
                works when every ancestor has it, so the first tap on an address suggestion
                (with the keyboard up) selects it instead of just closing the keyboard. */}
            <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps='handled'>
                <View style={styles.header}>
                    <Text style={styles.title}>{getStepTitle()}</Text>
                    <Text style={styles.subtitle}>{getStepSubtitle()}</Text>
                </View>

                {step === 1 ? (
                <View style={styles.form}>
                    <Text style={styles.label}>FULL NAME</Text>
                    <TextInput
                        style={styles.input}
                        value={name}
                        onChangeText={setName}
                        placeholder="John Doe"
                        placeholderTextColor={theme.colors.gray}
                    />

                    <Text style={styles.label}>EMAIL</Text>
                    <TextInput
                        style={styles.input}
                        autoCapitalize="none"
                        keyboardType="email-address"
                        autoCorrect={false}
                        value={email}
                        onChangeText={setEmail}
                        placeholder="email@domain.com"
                        placeholderTextColor={theme.colors.gray}
                    />

                    <Text style={styles.label}>PASSWORD</Text>
                    <TextInput
                        style={styles.input}
                        secureTextEntry
                        value={password}
                        onChangeText={setPassword}
                        placeholder="Min 8 chars, with letter and number"
                        placeholderTextColor={theme.colors.gray}
                    />

                    <TouchableOpacity
                        style={styles.tosRow}
                        onPress={() => setTosAccepted(!tosAccepted)}
                        activeOpacity={0.7}
                    >
                        <View style={[styles.checkbox, tosAccepted && styles.checkboxChecked]}>
                            {tosAccepted && (
                                <MaterialCommunityIcons name="check" size={16} color={theme.colors.textPrimary} />
                            )}
                        </View>
                        <Text style={styles.tosText}>
                            I agree to the{' '}
                            <Text
                                style={styles.tosLink}
                                onPress={() => Linking.openURL(TERMS_URL)}
                            >
                                Terms of Service
                            </Text>
                            {' '}and{' '}
                            <Text
                                style={styles.tosLink}
                                onPress={() => Linking.openURL(PRIVACY_URL)}
                            >
                                Privacy Policy
                            </Text>
                        </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.button, !tosAccepted && styles.buttonDisabled]}
                        onPress={handleStep1Next}
                        disabled={loading || !tosAccepted}
                    >
                        {loading ? (
                            <ActivityIndicator color={theme.colors.textPrimary} />
                        ) : (
                            <Text style={styles.buttonText}>NEXT</Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity onPress={() => navigation.goBack()} style={styles.linkContainer}>
                        <Text style={styles.linkText}>Already have an account? <Text style={styles.linkHighlight}>Login</Text></Text>
                    </TouchableOpacity>
                </View>
                ) : step === 2 ? (
                <View style={styles.form}>
                    <Text style={styles.label}>I WANT TO:</Text>

                    <TouchableOpacity
                        style={[styles.toggleOption, joiningExistingOrg && styles.toggleOptionSelected]}
                        onPress={() => selectJoinMode(true)}
                    >
                        <View style={styles.toggleOptionContent}>
                            <Text style={[styles.toggleOptionTitle, joiningExistingOrg && styles.toggleOptionTitleSelected]}>
                                Join Existing Organization
                            </Text>
                            <Text style={styles.toggleOptionSubtitle}>I have an invite code</Text>
                        </View>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.toggleOption, !joiningExistingOrg && styles.toggleOptionSelected]}
                        onPress={() => selectJoinMode(false)}
                    >
                        <View style={styles.toggleOptionContent}>
                            <Text style={[styles.toggleOptionTitle, !joiningExistingOrg && styles.toggleOptionTitleSelected]}>
                                Create New Organization
                            </Text>
                            <Text style={styles.toggleOptionSubtitle}>I'm setting up a new security network</Text>
                        </View>
                    </TouchableOpacity>

                    {joiningExistingOrg ? (
                        <View style={styles.inviteCodeSection}>
                            <Text style={styles.label}>INVITE CODE</Text>
                            <TextInput
                                style={[styles.input, styles.codeInput]}
                                autoCapitalize="characters"
                                value={inviteCode}
                                onChangeText={(text) => {
                                    setInviteCode(text);
                                    setValidatedOrgName('');
                                }}
                                autoCorrect={false}
                                placeholder="JOIN-XXXX-XXXX"
                                placeholderTextColor={theme.colors.gray}
                            />
                            {validatedOrgName ? (
                                <View style={styles.validationSuccess}>
                                    <Text style={styles.validationText}>✓ Joining: {validatedOrgName}</Text>
                                </View>
                            ) : null}
                        </View>
                    ) : null}

                    <TouchableOpacity
                        style={styles.button}
                        onPress={handleStep2Next}
                        disabled={loading}
                    >
                        {loading ? (
                            <ActivityIndicator color={theme.colors.textPrimary} />
                        ) : (
                            <Text style={styles.buttonText}>NEXT</Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity onPress={() => setStep(1)} style={styles.linkContainer} disabled={loading}>
                        <Text style={styles.linkText}>← Back</Text>
                    </TouchableOpacity>
                </View>
                ) : step === 3 ? (
                <ScrollView
                    style={styles.form}
                    keyboardShouldPersistTaps='handled'
                    contentContainerStyle={{ flexGrow: 1 }}
                >
                    <Text style={styles.label}>CHURCH/ORGANIZATION NAME</Text>
                    <TextInput
                        style={styles.input}
                        value={churchName}
                        onChangeText={setChurchName}
                        placeholder="First Baptist Church"
                        placeholderTextColor={theme.colors.gray}
                        maxLength={100}
                    />

                    <Text style={styles.label}>FULL ADDRESS</Text>
                    <GooglePlacesAutocomplete
                        ref={placesRef}
                        placeholder='Search for church address...'
                        onPress={(data, details = null) => {
                            setChurchAddress(data.description);
                            if (details?.geometry?.location) {
                                setCoordinates({
                                    latitude: details.geometry.location.lat,
                                    longitude: details.geometry.location.lng,
                                });
                            }
                        }}
                        query={{
                            key: GOOGLE_PLACES_API_KEY,
                            language: 'en',
                        }}
                        fetchDetails={true}
                        enablePoweredByContainer={false}
                        minLength={2}
                        debounce={200}
                        textInputProps={{
                            autoCorrect: false,
                            autoCapitalize: 'none',
                            spellCheck: false,
                            autoComplete: 'off',
                            keyboardType: 'default',
                        }}
                        keyboardShouldPersistTaps='handled'
                        listViewDisplayed='auto'
                        keepResultsAfterBlur={true}
                        styles={{
                            container: {
                                flex: 0,
                                marginBottom: 20,
                                zIndex: 1,
                            },
                            textInput: {
                                backgroundColor: theme.colors.white,
                                height: 54,
                                borderRadius: 8,
                                paddingHorizontal: 16,
                                fontSize: 16,
                                borderWidth: 1,
                                borderColor: theme.colors.border,
                                color: theme.colors.textPrimary,
                            },
                            listView: {
                                backgroundColor: theme.colors.white,
                                borderRadius: 8,
                                marginTop: 5,
                                elevation: 3,
                                shadowColor: '#000',
                                shadowOffset: { width: 0, height: 2 },
                                shadowOpacity: 0.25,
                                shadowRadius: 4,
                            },
                            row: {
                                backgroundColor: theme.colors.white,
                                padding: 18,
                                minHeight: 66,
                                borderBottomWidth: 1,
                                borderBottomColor: '#f0f0f0',
                                justifyContent: 'center',
                            },
                            description: {
                                color: theme.colors.textPrimary,
                                fontSize: 15,
                            },
                            separator: {
                                height: 0,
                            },
                        }}
                    />

                    {/* Verification fields */}
                    <View style={styles.verificationSection}>
                        <Text style={styles.sectionTitle}>VERIFICATION INFO</Text>
                        <Text style={styles.sectionSubtitle}>
                            Providing more info speeds up verification. A matching EIN and Google-listed address can approve your organization automatically; otherwise an administrator reviews it.
                        </Text>

                        <Text style={styles.label}>EIN / TAX ID (OPTIONAL)</Text>
                        <TextInput
                            style={styles.input}
                            value={ein}
                            onChangeText={(text) => setEin(formatEIN(text))}
                            placeholder="XX-XXXXXXX"
                            placeholderTextColor={theme.colors.gray}
                            keyboardType="number-pad"
                            maxLength={10}
                        />

                        <Text style={styles.label}>ORGANIZATION WEBSITE (OPTIONAL)</Text>
                        <TextInput
                            style={styles.input}
                            value={website}
                            onChangeText={setWebsite}
                            placeholder="www.yourchurch.org"
                            placeholderTextColor={theme.colors.gray}
                            autoCapitalize="none"
                            keyboardType="url"
                        />

                        <Text style={styles.label}>ORGANIZATION PHONE (OPTIONAL)</Text>
                        <TextInput
                            style={styles.input}
                            value={orgPhone}
                            onChangeText={setOrgPhone}
                            placeholder="(555) 123-4567"
                            placeholderTextColor={theme.colors.gray}
                            keyboardType="phone-pad"
                        />
                    </View>

                    <TouchableOpacity
                        style={styles.button}
                        onPress={handleCompleteSignup}
                        disabled={loading}
                    >
                        {loading ? (
                            <ActivityIndicator color={theme.colors.textPrimary} />
                        ) : (
                            <Text style={styles.buttonText}>COMPLETE REGISTRATION</Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity onPress={() => setStep(2)} style={styles.linkContainer} disabled={loading}>
                        <Text style={styles.linkText}>← Back</Text>
                    </TouchableOpacity>
                </ScrollView>
                ) : step === 4 ? (
                <View style={styles.form}>
                    <View style={styles.verificationStatusContainer}>
                        <MaterialCommunityIcons
                            name={verificationResults?.status === 'verified' ? 'shield-check' : 'shield-lock-outline'}
                            size={64}
                            color={verificationResults?.status === 'verified' ? theme.colors.verificationVerified : theme.colors.verificationPending}
                        />

                        <Text style={styles.verificationTitle}>
                            {verifying ? 'VERIFYING ORGANIZATION...' :
                             verificationResults?.status === 'verified' ? 'ORGANIZATION VERIFIED!' :
                             'UNDER REVIEW'}
                        </Text>

                        <Text style={styles.verificationSubtext}>
                            {verifying ? 'Running automated checks on your organization...' :
                             verificationResults?.status === 'verified'
                                ? 'Your organization has been approved. Next, verify your email address.'
                                : verificationResults?.incomplete
                                    ? "Your account is set up. We couldn't finish the automated checks just now; you can run them again after you verify your email. If your organization isn't approved automatically, a HolyGuard administrator will review it."
                                    : "Your account is set up. If your organization isn't approved automatically, a HolyGuard administrator will review it."}
                        </Text>

                        {verifying && (
                            <ActivityIndicator size="large" color={theme.colors.primary} style={{ marginTop: 20 }} />
                        )}

                        {verificationResults && !verifying && !verificationResults.incomplete && (
                            <View style={styles.checksCard}>
                                <Text style={styles.checksTitle}>Verification Checks</Text>

                                {VERIFICATION_CHECK_LABELS.map(({ key, label }) => {
                                    const check = verificationResults.checks?.[key];
                                    const icon = getCheckIcon(check?.status || 'skipped');
                                    return (
                                        <View key={key} style={styles.checkRow}>
                                            <MaterialCommunityIcons name={icon.name} size={20} color={icon.color} />
                                            <Text style={styles.checkLabel}>{label}</Text>
                                            <Text style={[styles.checkScore, { color: icon.color }]}>
                                                {check?.score || 0} pts
                                            </Text>
                                        </View>
                                    );
                                })}

                                <View style={styles.scoreDivider} />
                                <View style={styles.checkRow}>
                                    <MaterialCommunityIcons name="sigma" size={20} color={theme.colors.textPrimary} />
                                    <Text style={[styles.checkLabel, { fontWeight: 'bold' }]}>Total Score</Text>
                                    <Text style={[styles.checkScore, { fontWeight: 'bold', color: theme.colors.textPrimary }]}>
                                        {verificationResults.score || 0} pts
                                    </Text>
                                </View>
                                <Text style={styles.thresholdNote}>60 points approves an organization automatically.</Text>
                            </View>
                        )}

                        {verificationResults && !verifying && (
                            <Text style={styles.verificationNote}>
                                {verificationResults.status === 'verified'
                                    ? 'Check your inbox for the verification link, then start using HolyGuard.'
                                    : 'Check your inbox for the verification link. After you verify your email, you can add details to speed up approval.'}
                            </Text>
                        )}

                        {!verifying && (
                            <TouchableOpacity
                                style={[styles.button, styles.continueButton]}
                                onPress={handleContinueAfterVerification}
                                disabled={finishing}
                            >
                                {finishing ? (
                                    <ActivityIndicator color={theme.colors.textPrimary} />
                                ) : (
                                    <Text style={styles.buttonText}>CONTINUE</Text>
                                )}
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
                ) : null}
            </ScrollView>
        </KeyboardAvoidingView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    scrollContent: {
        flexGrow: 1,
        padding: theme.spacing.l,
        justifyContent: 'center',
    },
    header: {
        alignItems: 'center',
        marginBottom: 40,
    },
    title: {
        fontSize: 24,
        fontWeight: '900',
        color: theme.colors.textPrimary,
        letterSpacing: 2,
    },
    subtitle: {
        fontSize: 12,
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
    codeInput: {
        borderColor: theme.colors.primary,
        borderWidth: 2,
        fontWeight: 'bold',
        letterSpacing: 2,
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
    },
    toggleOption: {
        backgroundColor: theme.colors.white,
        borderWidth: 2,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 16,
        marginBottom: 16,
    },
    toggleOptionSelected: {
        borderColor: theme.colors.primary,
        backgroundColor: '#f8f9ff',
    },
    toggleOptionContent: {
        flexDirection: 'column',
    },
    toggleOptionTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        color: theme.colors.textPrimary,
        marginBottom: 4,
    },
    toggleOptionTitleSelected: {
        color: theme.colors.primary,
    },
    toggleOptionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    inviteCodeSection: {
        marginTop: 8,
    },
    validationSuccess: {
        backgroundColor: '#e6f7e6',
        padding: 12,
        borderRadius: 6,
        marginTop: -10,
        marginBottom: 10,
    },
    validationText: {
        color: '#2d7a2d',
        fontSize: 14,
        fontWeight: '600',
    },
    verificationSection: {
        marginTop: 8,
        marginBottom: 10,
        paddingTop: 16,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: '900',
        color: theme.colors.primary,
        letterSpacing: 1,
        marginBottom: 4,
    },
    sectionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 16,
        lineHeight: 18,
    },
    verificationStatusContainer: {
        alignItems: 'center',
        paddingVertical: 20,
    },
    verificationTitle: {
        fontSize: 20,
        fontWeight: '900',
        color: theme.colors.textPrimary,
        letterSpacing: 1,
        marginTop: 16,
        textAlign: 'center',
    },
    verificationSubtext: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 8,
        lineHeight: 20,
        paddingHorizontal: 10,
    },
    checksCard: {
        backgroundColor: theme.colors.white,
        borderRadius: 12,
        padding: 16,
        marginTop: 24,
        width: '100%',
        borderWidth: 1,
        borderColor: theme.colors.border,
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
    continueButton: {
        alignSelf: 'stretch',
        marginTop: 24,
    },
    verificationNote: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 20,
        lineHeight: 18,
        fontStyle: 'italic',
    },
    tosRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginTop: 8,
        marginBottom: 4,
    },
    checkbox: {
        width: 24,
        height: 24,
        borderRadius: 4,
        borderWidth: 2,
        borderColor: theme.colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 10,
        marginTop: 1,
    },
    checkboxChecked: {
        backgroundColor: theme.colors.primary,
        borderColor: theme.colors.primary,
    },
    tosText: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.textSecondary,
        lineHeight: 20,
    },
    tosLink: {
        color: theme.colors.primary,
        fontWeight: 'bold',
        textDecorationLine: 'underline',
    },
    buttonDisabled: {
        opacity: 0.5,
    },
});
