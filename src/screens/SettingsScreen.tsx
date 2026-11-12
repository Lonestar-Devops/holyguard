import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, TextInput, ActivityIndicator, ScrollView, Modal, KeyboardAvoidingView, Platform, Image, Linking } from 'react-native';
import Constants from 'expo-constants';
import { logger } from '../utils/logger';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { theme } from '../theme';
import { useAuth } from '../context/AuthContext';
import { auth, db } from '../config/firebase';
import { updatePassword, reauthenticateWithCredential, EmailAuthProvider } from 'firebase/auth';
import { doc, getDoc, updateDoc, query, collection, where, getDocs } from 'firebase/firestore';
import { GooglePlacesAutocomplete } from 'react-native-google-places-autocomplete';
import { GOOGLE_PLACES_API_KEY } from '../config/keys';
import { DeleteAccountModal } from '../components/DeleteAccountModal';
import { SUPPORT_EMAIL, SUPPORT_MAILTO, PRIVACY_URL, TERMS_URL } from '../constants/links';

interface SettingsScreenProps {
  navigation: any;
}

// The org's stored location when it can be saved back as is (the rules take only numbers in range).
const savedCoordinates = (org: any) =>
  Number.isFinite(org?.latitude) && Number.isFinite(org?.longitude) &&
  Math.abs(org.latitude) <= 90 && Math.abs(org.longitude) <= 180
    ? { latitude: org.latitude as number, longitude: org.longitude as number }
    : null;

// Marketing version from the app config, build number from the installed binary's
// CFBundleVersion (falls back to the config value where the native one isn't available).
// Android has no native build number here, so it uses the config's versionCode.
const APP_VERSION = Constants.expoConfig?.version ?? '';
const ANDROID_VERSION_CODE = Constants.expoConfig?.android?.versionCode;
const BUILD_NUMBER =
  Platform.OS === 'ios'
    ? Constants.platform?.ios?.buildNumber ?? Constants.expoConfig?.ios?.buildNumber ?? null
    : ANDROID_VERSION_CODE != null
      ? String(ANDROID_VERSION_CODE)
      : null;
const VERSION_LABEL = APP_VERSION
  ? `Version ${APP_VERSION}${BUILD_NUMBER ? ` (${BUILD_NUMBER})` : ''}`
  : null;

// Friendly text for the Firebase Auth errors Change Password can hit. Firebase JS 12 reports a
// mistyped current password as auth/invalid-credential when email enumeration protection is on,
// and as auth/wrong-password otherwise.
const changePasswordErrorMessage = (code: string | undefined): string => {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/invalid-login-credentials':
      return 'Your current password is incorrect. Please try again.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'Your new password is too weak. Please choose a longer or more complex password.';
    case 'auth/network-request-failed':
      return "Couldn't reach the server. Check your connection and try again.";
    case 'auth/requires-recent-login':
    case 'auth/user-token-expired':
    case 'auth/user-mismatch':
      return 'Your session has expired. Please sign out, sign back in, and try again.';
    default:
      return "Couldn't update your password. Please try again.";
  }
};

const openExternal = async (url: string, fallbackTitle: string, fallbackMessage: string) => {
  try {
    await Linking.openURL(url);
  } catch (error) {
    logger.warn('Could not open link:', url, error);
    Alert.alert(fallbackTitle, fallbackMessage);
  }
};

export const SettingsScreen: React.FC<SettingsScreenProps> = ({ navigation }) => {
  const { user, logout } = useAuth();
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  
  // Organization state
  const [showOrgModal, setShowOrgModal] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgAddress, setOrgAddress] = useState('');
  const [orgCoordinates, setOrgCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
  const [currentOrg, setCurrentOrg] = useState<any>(null);
  const [loadingOrg, setLoadingOrg] = useState(false);
  const [orgLoadError, setOrgLoadError] = useState<'missing' | 'failed' | null>(null);
  const [placesError, setPlacesError] = useState<string | null>(null);
  const placesRef = useRef<any>(null);

  // Delete Account (the modal owns the whole flow, including sign-out on success)
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // Load organization on mount
  useEffect(() => {
    loadOrganization();
  }, [user?.organizationId]);

  // Reset modal state when opening
  useEffect(() => {
    if (showOrgModal && currentOrg) {
      setOrgName(currentOrg.name || '');
      setOrgAddress(currentOrg.address || '');
      setOrgCoordinates(savedCoordinates(currentOrg));
      setPlacesError(null);
      placesRef.current?.setAddressText(currentOrg.address || '');
    }
  }, [showOrgModal]);

  const loadOrganization = async () => {
    if (!user?.organizationId) return;
    setOrgLoadError(null);

    try {
      // Try to get by document ID first
      let orgDoc = await getDoc(doc(db, 'organizations', user.organizationId));
      
      // If not found, try querying by id field
      if (!orgDoc.exists()) {
        const orgsQuery = query(
          collection(db, 'organizations'),
          where('id', '==', user.organizationId)
        );
        const snapshot = await getDocs(orgsQuery);
        if (!snapshot.empty) {
          orgDoc = snapshot.docs[0];
        }
      }
      
      if (orgDoc.exists()) {
        const orgData = orgDoc.data();
        // The doc id goes last: an app-created org's `id` field ('org_<ms>') is not its doc
        // id, and Update Organization writes to organizations/<currentOrg.id>.
        setCurrentOrg({ ...orgData, id: orgDoc.id });
        setOrgName(orgData.name || '');
        setOrgAddress(orgData.address || '');
      } else {
        setOrgLoadError('missing');
      }
    } catch (error) {
      logger.error('Error loading organization:', error);
      setOrgLoadError('failed');
    }
  };

  const handleUpdateOrganization = async () => {
    if (!orgName.trim()) {
      Alert.alert('Error', 'Please enter organization name');
      return;
    }
    
    if (!orgAddress || !orgCoordinates) {
      Alert.alert('Error', 'Please select an address from the dropdown');
      return;
    }

    // The rules check the whole saved doc, so an older org's over-long name or address
    // would block every save with a permission error.
    if (orgName.trim().length > 100) {
      Alert.alert('Error', 'Organization name must be 100 characters or fewer.');
      return;
    }
    if (orgAddress.length > 300) {
      Alert.alert('Error', 'Please choose the address from the list again.');
      return;
    }

    setLoadingOrg(true);
    try {
      if (!currentOrg) throw new Error('Organization not found');
      
      const orgRef = doc(db, 'organizations', currentOrg.id);
      await updateDoc(orgRef, {
        name: orgName.trim(),
        address: orgAddress,
        latitude: orgCoordinates.latitude,
        longitude: orgCoordinates.longitude,
      });
      
      Alert.alert('Success', 'Organization updated successfully');
      setShowOrgModal(false);
      await loadOrganization(); // Reload
    } catch (error: any) {
      Alert.alert('Error', error?.code === 'permission-denied'
        ? "Your account isn't allowed to update this organization. Contact support if you are its admin."
        : error.message || 'Failed to update organization');
    } finally {
      setLoadingOrg(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      Alert.alert('Error', 'Please fill in all password fields');
      return;
    }

    if (newPassword !== confirmPassword) {
      Alert.alert('Error', 'New passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      Alert.alert('Error', 'Password must be at least 8 characters');
      return;
    }

    setLoading(true);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser || !currentUser.email) {
        Alert.alert('Error', 'Your session has expired. Please sign out, sign back in, and try again.');
        return;
      }

      // Reauthenticate user
      const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
      await reauthenticateWithCredential(currentUser, credential);

      // Update password
      await updatePassword(currentUser, newPassword);

      Alert.alert('Success', 'Password updated successfully');
      setShowChangePassword(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error: any) {
      logger.warn('Change password failed:', error?.code);
      Alert.alert('Error', changePasswordErrorMessage(error?.code));
    } finally {
      setLoading(false);
    }
  };

  const handleContactSupport = () =>
    openExternal(SUPPORT_MAILTO, 'Contact Support', `Email us at ${SUPPORT_EMAIL}`);

  const handleOpenPrivacyPolicy = () =>
    openExternal(PRIVACY_URL, 'Privacy Policy', `Read our Privacy Policy at ${PRIVACY_URL}`);

  const handleOpenTerms = () =>
    openExternal(TERMS_URL, 'Terms of Use', `Read our Terms of Use at ${TERMS_URL}`);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.backButton} />
      </View>

      {/* The keyboard would otherwise cover the lower Change Password fields and swallow the
          first tap on Update Password. */}
      <ScrollView
        style={styles.content}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {/* User Info Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ACCOUNT</Text>
          <View style={styles.infoCard}>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Name</Text>
              <Text style={styles.infoValue}>{user?.name || 'N/A'}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Email</Text>
              <Text style={styles.infoValue}>{auth.currentUser?.email || 'N/A'}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Role</Text>
              <Text style={[styles.infoValue, styles.roleBadge]}>
                {user?.role?.toUpperCase() || 'N/A'}
              </Text>
            </View>
          </View>
        </View>

        {/* Security Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SECURITY</Text>
          
          {!showChangePassword ? (
            <TouchableOpacity
              style={styles.settingsButton}
              onPress={() => setShowChangePassword(true)}
            >
              <MaterialCommunityIcons name="lock-reset" size={24} color={theme.colors.primary} />
              <Text style={styles.settingsButtonText}>Change Password</Text>
              <MaterialCommunityIcons name="chevron-right" size={24} color={theme.colors.gray} />
            </TouchableOpacity>
          ) : (
            <View style={styles.changePasswordCard}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Change Password</Text>
                <TouchableOpacity onPress={() => setShowChangePassword(false)}>
                  <MaterialCommunityIcons name="close" size={24} color={theme.colors.gray} />
                </TouchableOpacity>
              </View>

              <Text style={styles.inputLabel}>Current Password</Text>
              <TextInput
                style={styles.input}
                value={currentPassword}
                onChangeText={setCurrentPassword}
                placeholder="Enter current password"
                placeholderTextColor={theme.colors.gray}
                secureTextEntry
                autoCapitalize="none"
              />

              <Text style={styles.inputLabel}>New Password</Text>
              <TextInput
                style={styles.input}
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder="Enter new password (min 8 chars)"
                placeholderTextColor={theme.colors.gray}
                secureTextEntry
                autoCapitalize="none"
              />

              <Text style={styles.inputLabel}>Confirm New Password</Text>
              <TextInput
                style={styles.input}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder="Confirm new password"
                placeholderTextColor={theme.colors.gray}
                secureTextEntry
                autoCapitalize="none"
              />

              <TouchableOpacity
                style={[styles.updateButton, loading && styles.updateButtonDisabled]}
                onPress={handleChangePassword}
                disabled={loading}
              >
                {loading ? (
                  <ActivityIndicator color={theme.colors.textPrimary} />
                ) : (
                  <Text style={styles.updateButtonText}>UPDATE PASSWORD</Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          <TouchableOpacity
            style={styles.settingsButton}
            onPress={() => navigation.navigate('BlockedUsers')}
          >
            <MaterialCommunityIcons name="account-cancel" size={24} color={theme.colors.primary} />
            <Text style={styles.settingsButtonText}>Blocked Users</Text>
            <MaterialCommunityIcons name="chevron-right" size={24} color={theme.colors.gray} />
          </TouchableOpacity>
        </View>

        {/* Danger Zone */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>DANGER ZONE</Text>
          <TouchableOpacity
            style={styles.deleteButton}
            onPress={() => setShowDeleteModal(true)}
            disabled={loading}
          >
            <MaterialCommunityIcons name="delete-forever" size={24} color={theme.colors.danger} />
            <Text style={styles.deleteButtonText}>Delete Account</Text>
          </TouchableOpacity>
          <Text style={styles.deleteWarning}>
            This will permanently delete your account and all associated data. This action cannot be undone.
          </Text>
        </View>

        {/* Organization Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ORGANIZATION</Text>
          {currentOrg ? (
            <View style={styles.infoCard}>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Name</Text>
                <Text style={styles.infoValue}>{currentOrg.name || 'N/A'}</Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Address</Text>
                <Text style={[styles.infoValue, { flex: 1, textAlign: 'right' }]} numberOfLines={2}>
                  {currentOrg.address || 'N/A'}
                </Text>
              </View>
              {(user?.role === 'admin' || user?.role === 'super_admin') && (
                <TouchableOpacity
                  style={styles.updateOrgButton}
                  onPress={() => setShowOrgModal(true)}
                >
                  <MaterialCommunityIcons name="map-marker-edit" size={20} color={theme.colors.primary} />
                  <Text style={styles.updateOrgButtonText}>Update Organization</Text>
                </TouchableOpacity>
              )}
              {(user?.role === 'admin' || user?.role === 'super_admin') && (
                <TouchableOpacity
                  style={styles.updateOrgButton}
                  onPress={() => navigation.navigate('SeatManagement')}
                >
                  <MaterialCommunityIcons name="account-group" size={20} color={theme.colors.primary} />
                  <Text style={styles.updateOrgButtonText}>Manage Seats</Text>
                </TouchableOpacity>
              )}
              {(user?.role === 'admin' || user?.role === 'super_admin') && (
                <TouchableOpacity
                  style={styles.updateOrgButton}
                  onPress={() => navigation.navigate('SubscriptionPlans')}
                >
                  <MaterialCommunityIcons name="shield-star" size={20} color={theme.colors.primary} />
                  <Text style={styles.updateOrgButtonText}>Subscription Plans</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : orgLoadError ? (
            <View style={styles.infoCard}>
              <Text style={styles.orgLoadErrorText}>
                {orgLoadError === 'missing'
                  ? "Your account isn't linked to an organization."
                  : "Couldn't load your organization."}
              </Text>
              {orgLoadError === 'failed' && (
                <TouchableOpacity style={styles.updateOrgButton} onPress={loadOrganization}>
                  <MaterialCommunityIcons name="refresh" size={20} color={theme.colors.primary} />
                  <Text style={styles.updateOrgButtonText}>Retry</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <ActivityIndicator size="small" color={theme.colors.primary} />
          )}
        </View>

        {/* About Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ABOUT</Text>
          <TouchableOpacity style={styles.settingsButton} onPress={handleContactSupport}>
            <MaterialCommunityIcons name="email-outline" size={24} color={theme.colors.primary} />
            <Text style={styles.settingsButtonText}>Contact Support</Text>
            <MaterialCommunityIcons name="chevron-right" size={24} color={theme.colors.gray} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.settingsButton} onPress={handleOpenPrivacyPolicy}>
            <MaterialCommunityIcons name="shield-lock-outline" size={24} color={theme.colors.primary} />
            <Text style={styles.settingsButtonText}>Privacy Policy</Text>
            <MaterialCommunityIcons name="open-in-new" size={20} color={theme.colors.gray} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.settingsButton} onPress={handleOpenTerms}>
            <MaterialCommunityIcons name="file-document-outline" size={24} color={theme.colors.primary} />
            <Text style={styles.settingsButtonText}>Terms of Use</Text>
            <MaterialCommunityIcons name="open-in-new" size={20} color={theme.colors.gray} />
          </TouchableOpacity>

          <View style={[styles.aboutCard, styles.aboutCardSpaced]}>
            <Text style={styles.appTitle}>HolyGuard</Text>
            <Text style={styles.appTagline}>Security Network Application</Text>
            {VERSION_LABEL ? <Text style={styles.appVersion}>{VERSION_LABEL}</Text> : null}

            <View style={styles.sponsorSection}>
              <Text style={styles.sponsorLabel}>Developed By</Text>
              <View style={styles.sponsorLogosLarge}>
                <Image source={require('../../assets/cowboystate.png')} style={styles.sponsorLogoLarge} resizeMode="contain" />
              </View>
              <Text style={styles.sponsorDescription}>
                Providing secure communication and alert systems for communities and organizations.
              </Text>
            </View>
            
            <View style={styles.divider} />
            
            <Text style={styles.copyrightText}>© 2026 HolyGuard. All rights reserved.</Text>
          </View>
        </View>

        {/* Logout */}
        <TouchableOpacity style={styles.logoutButton} onPress={logout}>
          <Text style={styles.logoutText}>LOGOUT</Text>
        </TouchableOpacity>
      </ScrollView>

      <DeleteAccountModal visible={showDeleteModal} onClose={() => setShowDeleteModal(false)} />

      {/* Organization Update Modal */}
      <Modal
        visible={showOrgModal}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setShowOrgModal(false)}
      >
        <SafeAreaView style={styles.modalContainer} edges={['bottom']}>
          <View style={styles.modalHeader}>
            <TouchableOpacity 
              onPress={() => setShowOrgModal(false)}
              style={styles.modalCloseButton}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <MaterialCommunityIcons name="close" size={28} color="#000" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Update Organization</Text>
            <View style={{ width: 28 }} />
          </View>
          <KeyboardAvoidingView 
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >

          <ScrollView 
            style={styles.modalContent} 
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.modalContentContainer}
          >
            <Text style={styles.modalLabel}>Organization Name</Text>
            <TextInput
              style={styles.modalInput}
              value={orgName}
              onChangeText={setOrgName}
              placeholder="Enter organization name"
              placeholderTextColor="#999"
              maxLength={100}
            />

            <Text style={[styles.modalLabel, { marginTop: 20 }]}>Organization Address</Text>
            <View style={styles.placesContainer}>
              <GooglePlacesAutocomplete
                ref={placesRef}
                placeholder="Search for address"
                onPress={(data, details = null) => {
                  const location = details?.geometry?.location;
                  if (!location) {
                    setPlacesError("Couldn't look up that address. Please choose it again.");
                    return;
                  }
                  setPlacesError(null);
                  setOrgAddress(data.description);
                  setOrgCoordinates({ latitude: location.lat, longitude: location.lng });
                }}
                onFail={() => setPlacesError("Address search isn't working right now. Please try again later.")}
                onNotFound={() => setPlacesError("Couldn't find that address. Please choose another one.")}
                onTimeout={() => setPlacesError('Address search timed out. Please try again.')}
                query={{
                  key: GOOGLE_PLACES_API_KEY,
                  language: 'en',
                }}
                GooglePlacesDetailsQuery={{ fields: 'geometry' }}
                fetchDetails={true}
                minLength={2}
                debounce={200}
                enablePoweredByContainer={false}
                textInputProps={{
                  placeholderTextColor: '#999',
                  // Typed text counts only once it's picked from the list. Until then the saved
                  // location is dropped, so the old address can't be saved as if it were the
                  // new one. Clearing the field, or retyping the saved address, keeps it.
                  onChangeText: (text: string) => {
                    setPlacesError(null);
                    if (!text.trim() || text === (currentOrg?.address || '')) {
                      setOrgAddress(currentOrg?.address || '');
                      setOrgCoordinates(savedCoordinates(currentOrg));
                    } else if (text !== orgAddress) {
                      setOrgCoordinates(null);
                    }
                  },
                }}
                styles={{
                  container: {
                    flex: 0,
                    zIndex: 1000,
                  },
                  textInputContainer: {
                    backgroundColor: 'transparent',
                  },
                  textInput: {
                    backgroundColor: '#fff',
                    borderRadius: 8,
                    paddingHorizontal: 15,
                    height: 50,
                    fontSize: 16,
                    borderWidth: 1,
                    borderColor: '#ddd',
                  },
                  listView: {
                    backgroundColor: '#fff',
                    borderRadius: 8,
                    marginTop: 4,
                    elevation: 3,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.25,
                    shadowRadius: 3.84,
                  },
                  row: {
                    backgroundColor: '#fff',
                    padding: 13,
                    height: 60,
                  },
                  separator: {
                    height: 1,
                    backgroundColor: '#f0f0f0',
                  },
                }}
              />
            </View>

            {placesError ? (
              <Text style={styles.addressErrorText}>{placesError}</Text>
            ) : !orgAddress || !orgCoordinates ? (
              <Text style={styles.addressHintText}>
                Choose the address from the list to use it. If no list appears, check your connection and try again.
              </Text>
            ) : null}

            {orgAddress && orgCoordinates ? (
              <View style={styles.selectedAddressContainer}>
                <MaterialCommunityIcons name="map-marker" size={20} color={theme.colors.primary} />
                <Text style={styles.selectedAddressText}>{orgAddress}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.modalButton, (!orgName.trim() || !orgAddress || !orgCoordinates || loadingOrg) && styles.modalButtonDisabled]}
              onPress={handleUpdateOrganization}
              disabled={!orgName.trim() || !orgAddress || !orgCoordinates || loadingOrg}
            >
              {loadingOrg ? (
                <ActivityIndicator color={theme.colors.textPrimary} />
              ) : (
                <Text style={styles.modalButtonText}>Update Organization</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: theme.spacing.m,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backButton: {
    padding: 8,
    width: 40,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: theme.colors.textPrimary,
  },
  content: {
    flex: 1,
  },
  section: {
    padding: theme.spacing.m,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: theme.colors.textSecondary,
    letterSpacing: 1,
    marginBottom: 12,
  },
  infoCard: {
    backgroundColor: theme.colors.white,
    borderRadius: 8,
    padding: theme.spacing.m,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  infoLabel: {
    fontSize: 14,
    color: theme.colors.textSecondary,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.textPrimary,
  },
  roleBadge: {
    backgroundColor: theme.colors.primary,
    color: theme.colors.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  settingsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.white,
    padding: theme.spacing.m,
    borderRadius: 8,
    marginBottom: 8,
  },
  settingsButtonText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    marginLeft: 12,
  },
  changePasswordCard: {
    backgroundColor: theme.colors.white,
    borderRadius: 8,
    padding: theme.spacing.m,
    marginBottom: 8,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: theme.colors.textPrimary,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.textSecondary,
    marginBottom: 8,
    marginTop: 8,
  },
  input: {
    backgroundColor: theme.colors.surface,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: theme.colors.textPrimary,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  updateButton: {
    backgroundColor: theme.colors.primary,
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 16,
  },
  updateButtonDisabled: {
    backgroundColor: theme.colors.gray,
  },
  updateButtonText: {
    color: theme.colors.textPrimary,
    fontWeight: 'bold',
    fontSize: 14,
    letterSpacing: 1,
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.white,
    padding: theme.spacing.m,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: theme.colors.danger,
  },
  deleteButtonText: {
    flex: 1,
    fontSize: 16,
    fontWeight: 'bold',
    color: theme.colors.danger,
    marginLeft: 12,
  },
  deleteWarning: {
    fontSize: 12,
    color: theme.colors.textSecondary,
    marginTop: 8,
    lineHeight: 18,
  },
  logoutButton: {
    backgroundColor: theme.colors.danger,
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    margin: theme.spacing.m,
    marginTop: 24,
  },
  logoutText: {
    color: theme.colors.white,
    fontWeight: 'bold',
    fontSize: 16,
    letterSpacing: 1,
  },
  aboutCard: {
    backgroundColor: theme.colors.white,
    borderRadius: 8,
    padding: theme.spacing.l,
    alignItems: 'center',
  },
  aboutCardSpaced: {
    marginTop: 8,
  },
  appTitle: {
    fontSize: 28,
    fontWeight: '900',
    color: theme.colors.textPrimary,
    letterSpacing: 2,
    marginBottom: 4,
  },
  appTagline: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    marginBottom: 8,
  },
  appVersion: {
    fontSize: 12,
    color: theme.colors.gray,
    marginBottom: 24,
  },
  sponsorSection: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  sponsorLabel: {
    fontSize: 11,
    color: theme.colors.gray,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },
  sponsorLogosLarge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    marginBottom: 12,
  },
  sponsorLogoLarge: {
    width: 160,
    height: 120,
  },
  sponsorDescription: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 20,
  },
  copyrightText: {
    fontSize: 11,
    color: theme.colors.gray,
    marginTop: 16,
  },
  updateOrgButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  updateOrgButtonText: {
    color: theme.colors.primary,
    fontWeight: '600',
    fontSize: 14,
    marginLeft: 8,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 60,
    paddingBottom: 16,
    paddingHorizontal: theme.spacing.m,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  modalCloseButton: {
    padding: 4,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: theme.colors.textPrimary,
    flex: 1,
    textAlign: 'center',
  },
  modalContent: {
    flex: 1,
  },
  modalContentContainer: {
    padding: theme.spacing.m,
    paddingBottom: 100,
  },
  placesContainer: {
    minHeight: 300,
    marginBottom: 20,
  },
  modalLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    marginBottom: 8,
  },
  modalInput: {
    backgroundColor: theme.colors.white,
    borderRadius: 8,
    padding: 15,
    fontSize: 16,
    color: theme.colors.textPrimary,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  selectedAddressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.white,
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  selectedAddressText: {
    flex: 1,
    fontSize: 14,
    color: theme.colors.textPrimary,
    marginLeft: 8,
  },
  addressHintText: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    marginTop: 8,
  },
  addressErrorText: {
    fontSize: 13,
    color: theme.colors.danger,
    marginTop: 8,
  },
  orgLoadErrorText: {
    fontSize: 14,
    color: theme.colors.textSecondary,
  },
  modalButton: {
    backgroundColor: theme.colors.primary,
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 24,
  },
  modalButtonDisabled: {
    backgroundColor: theme.colors.gray,
    opacity: 0.5,
  },
  modalButtonText: {
    color: theme.colors.textPrimary,
    fontWeight: 'bold',
    fontSize: 16,
    letterSpacing: 1,
  },
});
