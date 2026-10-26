import React, { useState, useEffect, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ActivityIndicator,
    ScrollView,
    Alert,
    Linking,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { EventSubscription, ProductSubscription, Purchase, PurchaseError } from 'react-native-iap';
import { theme } from '../theme';
import { useAuth } from '../context/AuthContext';
import { auth } from '../config/firebase';
import {
    PLAN_CONFIG,
    PRODUCT_IDS,
    initIAP,
    fetchSubscriptionProducts,
    purchaseSubscription,
    fetchAvailablePurchases,
    finishPurchase,
    isUserCancelledError,
    isDeferredPaymentError,
    addPurchaseUpdateListener,
    addPurchaseErrorListener,
    type PlanKey,
} from '../config/iap';
import { logger } from '../utils/logger';

const VALIDATE_RECEIPT_URL = 'https://us-central1-holyguard-app.cloudfunctions.net/validateAppleReceipt';
const MANAGE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';
const TERMS_URL = 'https://atmksheldon.github.io/holyguard/terms.html';
const PRIVACY_URL = 'https://atmksheldon.github.io/holyguard/privacy.html';

const isOurProduct = (productId: string) => Object.values(PRODUCT_IDS).includes(productId);

// What to tell the admin when validateAppleReceipt (functions/index.js) rejects a purchase
// for a reason that retrying cannot fix. undefined: the failure was temporary (network, 5xx).
const permanentRejectionMessage = (status: number, error: unknown): string | undefined => {
    if (status === 403) return 'Only an organization admin can activate a subscription.';
    if (status === 404) return "Your account isn't linked to an organization. Please contact support.";
    if (status !== 200 || typeof error !== 'string') return undefined;
    if (error.includes('already linked')) {
        return "This Apple ID's HolyGuard subscription is already linked to another organization. Use the Apple ID that pays for this organization, or contact support.";
    }
    if (error === 'Subscription expired') return 'This subscription has expired. Choose a plan to subscribe again.';
    return 'The App Store purchase could not be verified for HolyGuard. Please contact support.';
};

interface PlanCardProps {
    planKey: PlanKey;
    selected: boolean;
    onSelect: () => void;
    storeSub?: ProductSubscription;
    popular?: boolean;
}

const PlanCard: React.FC<PlanCardProps> = ({ planKey, selected, onSelect, storeSub, popular }) => {
    const config = PLAN_CONFIG[planKey];
    const seats: number = config.seats;
    // App Store price once StoreKit has loaded the plan, otherwise the configured price.
    const displayPrice = storeSub?.displayPrice || config.price;

    return (
        <TouchableOpacity
            style={[styles.planCard, selected && styles.planCardSelected, popular && styles.planCardPopular]}
            onPress={onSelect}
            activeOpacity={0.7}
        >
            {popular && (
                <View style={styles.popularBadge}>
                    <Text style={styles.popularBadgeText}>BEST VALUE</Text>
                </View>
            )}
            <View style={styles.planHeader}>
                <Text style={[styles.planName, selected && styles.planNameSelected]}>{config.name}</Text>
                <Text style={[styles.planPrice, selected && styles.planPriceSelected]}>{displayPrice}</Text>
            </View>
            <Text style={styles.planDescription}>{config.description}</Text>
            <View style={styles.planFeatures}>
                <View style={styles.featureRow}>
                    <MaterialCommunityIcons name="account-group" size={16} color={selected ? theme.colors.primary : theme.colors.textSecondary} />
                    <Text style={styles.featureText}>{seats === 1 ? '1 seat' : `Up to ${seats} seats`}</Text>
                </View>
                <View style={styles.featureRow}>
                    <MaterialCommunityIcons name="shield-check" size={16} color={selected ? theme.colors.primary : theme.colors.textSecondary} />
                    <Text style={styles.featureText}>All security features</Text>
                </View>
                <View style={styles.featureRow}>
                    <MaterialCommunityIcons name="map-marker-radius" size={16} color={selected ? theme.colors.primary : theme.colors.textSecondary} />
                    <Text style={styles.featureText}>Network map access</Text>
                </View>
                {seats > 1 && (
                    <View style={styles.featureRow}>
                        <MaterialCommunityIcons name="cash" size={16} color={selected ? theme.colors.primary : theme.colors.textSecondary} />
                        <Text style={styles.featureText}>
                            ${(parseFloat(config.price.replace(/[^0-9.]/g, '')) / seats).toFixed(2)}/seat/mo
                        </Text>
                    </View>
                )}
            </View>
            <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
                {selected && <View style={styles.radioInner} />}
            </View>
        </TouchableOpacity>
    );
};

// Shown by RootNavigator to admins of an org without an active subscription, and from
// Settings → Subscription Plans (route 'SubscriptionPlans') to admins of an active org.
export const PaywallScreen = () => {
    const { user, refreshProfile } = useAuth();
    const isActive = user?.subscriptionStatus === 'active';
    const [selectedPlan, setSelectedPlan] = useState<PlanKey>('team');
    const [loading, setLoading] = useState(false);
    const [loadingProducts, setLoadingProducts] = useState(true);
    const [subs, setSubs] = useState<Record<string, ProductSubscription>>({});
    const [productsUnavailable, setProductsUnavailable] = useState(false);
    const purchaseUpdateSub = useRef<EventSubscription | null>(null);
    const purchaseErrorSub = useRef<EventSubscription | null>(null);
    const purchaseInFlight = useRef(false);
    // Transaction ids being validated now. StoreKit can deliver the same one twice.
    const validatingIds = useRef(new Set<string>());

    // For an unpaid org the purchase listeners attach once, after the StoreKit connection is
    // up. They keep this first render's handlers, which only use state setters, refs, auth and
    // refreshProfile. An active org (Settings → Subscription Plans) only sees the plans: nothing
    // is bought here, and validating a renewal from here would give a grandfathered org a plan
    // and seat cap, because validateAppleReceipt writes them unconditionally.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                await initIAP();
            } catch (error) {
                logger.error('PaywallScreen init wait failed:', error);
            }
            if (cancelled) return;
            if (!isActive) {
                try {
                    purchaseUpdateSub.current = addPurchaseUpdateListener(handlePurchase);
                    purchaseErrorSub.current = addPurchaseErrorListener(handlePurchaseError);
                } catch (error) {
                    logger.error('PaywallScreen listener attach failed:', error);
                }
                validateActivePurchase();
            }
            loadProducts();
        })();
        return () => {
            cancelled = true;
            try {
                purchaseUpdateSub.current?.remove();
            } catch (error) {
                logger.warn('purchaseUpdateSub remove failed:', error);
            }
            try {
                purchaseErrorSub.current?.remove();
            } catch (error) {
                logger.warn('purchaseErrorSub remove failed:', error);
            }
            // Only the listeners go. The IAP connection stays open (never endConnection()).
        };
    }, []);

    const loadProducts = async () => {
        setLoadingProducts(true);
        setProductsUnavailable(false);
        try {
            const products = await fetchSubscriptionProducts();
            if (!products.length) {
                setProductsUnavailable(true);
                setSubs({});
                return;
            }
            const productMap: Record<string, ProductSubscription> = {};
            for (const product of products) {
                productMap[product.id] = product;
            }
            setSubs(productMap);
        } catch (error) {
            logger.error('Load products error:', error);
            setProductsUnavailable(true);
            setSubs({});
        } finally {
            setLoadingProducts(false);
        }
    };

    // purchaseUpdatedListener callback: every completed purchase lands here, possibly twice
    // (the listener does not dedupe), so each transaction is validated once at a time.
    const handlePurchase = async (purchase: Purchase) => {
        if (!purchase?.productId) return;
        if (!isOurProduct(purchase.productId)) return;
        if (validatingIds.current.has(purchase.id)) return;
        validatingIds.current.add(purchase.id);
        try {
            // On iOS this is the StoreKit 2 signed transaction (JWS).
            const jws = purchase.purchaseToken;
            if (!jws) {
                logger.error('Purchase has no purchaseToken (JWS)');
                Alert.alert('Purchase Issue', 'Apple did not return purchase proof. Please try Restore Purchases.');
                return;
            }
            const result = await validateReceiptWithServer(jws, purchase.productId);
            if (!result.valid) {
                // Left unfinished on purpose, so Restore Purchases or the check when this screen
                // next opens can validate it again. StoreKit does not retry it by itself.
                Alert.alert(
                    'Purchase Validation Failed',
                    result.reason ?? 'We could not verify your purchase. If you were charged, tap Restore Purchases to retry.'
                );
                return;
            }
            await finishPurchase(purchase);
            // The server has set the org to active; RootNavigator then shows the app.
            await refreshProfile();
        } catch (error) {
            logger.error('handlePurchase error:', error);
        } finally {
            validatingIds.current.delete(purchase.id);
            setLoading(false);
            purchaseInFlight.current = false;
        }
    };

    // purchaseErrorListener callback. The stream also carries errors from outside a purchase
    // (a failed plan load), so only a purchase started here is reported. A user cancel just
    // resets the button.
    const handlePurchaseError = (error: PurchaseError) => {
        if (!purchaseInFlight.current) {
            logger.warn('IAP error outside a purchase:', error?.code, error?.message);
            return;
        }
        if (isDeferredPaymentError(error)) {
            // The approved purchase arrives later: handlePurchase takes it while this screen is
            // open, otherwise validateActivePurchase does when it next opens.
            Alert.alert(
                'Purchase Pending Approval',
                'Your purchase is waiting for approval. Once it is approved, open HolyGuard again to activate your subscription.'
            );
        } else if (!isUserCancelledError(error)) {
            logger.error('Purchase error:', error);
            Alert.alert('Purchase Failed', error?.message || 'Unable to complete purchase. Please try again.');
        }
        setLoading(false);
        purchaseInFlight.current = false;
    };

    // validateAppleReceipt verifies the JWS and writes the plan to the org server-side.
    // Only an org admin or super_admin is accepted. A rejection that retrying cannot fix
    // comes back with a reason to show; a temporary failure comes back without one.
    const validateReceiptWithServer = async (
        jws: string,
        productId: string
    ): Promise<{ valid: boolean; reason?: string }> => {
        try {
            // The cached profile can open this screen before Firebase Auth restores the user.
            await auth.authStateReady();
            const idToken = await auth.currentUser?.getIdToken();
            if (!idToken) {
                logger.error('No Firebase ID token available for receipt validation');
                return { valid: false };
            }
            const response = await fetch(VALIDATE_RECEIPT_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${idToken}`,
                },
                body: JSON.stringify({ jws, productId }),
            });
            const result = await response.json().catch(() => null);
            if (response.ok && result?.valid === true) {
                return { valid: true };
            }
            logger.error('Receipt validation rejected:', response.status, result?.error);
            return { valid: false, reason: permanentRejectionMessage(response.status, result?.error) };
        } catch (error) {
            logger.error('Receipt validation network error:', error);
            return { valid: false };
        }
    };

    // StoreKit replays an unfinished transaction once per launch, usually before this screen
    // listens, so a paid purchase whose validation never completed (network error, app closed
    // mid-check, Ask to Buy approved later) is not retried by itself. On open, quietly
    // validate this Apple ID's active plan; a failure stays silent (Restore reports it).
    const validateActivePurchase = async () => {
        try {
            const ours = (await fetchAvailablePurchases()).filter((p) => isOurProduct(p.productId));
            if (!ours.length || purchaseInFlight.current) return;
            const latest = ours.sort((a, b) => (b.transactionDate || 0) - (a.transactionDate || 0))[0];
            if (!latest.purchaseToken || validatingIds.current.has(latest.id)) return;
            validatingIds.current.add(latest.id);
            setLoading(true);
            try {
                const result = await validateReceiptWithServer(latest.purchaseToken, latest.productId);
                if (result.valid) {
                    await finishPurchase(latest);
                    await refreshProfile();
                }
            } finally {
                validatingIds.current.delete(latest.id);
                setLoading(false);
            }
        } catch (error) {
            logger.warn('Active purchase check failed:', error);
        }
    };

    const handleSubscribe = async () => {
        // validateAppleReceipt attaches a purchase to the caller's org, so without one the
        // payment could never activate anything.
        if (!user?.organizationId || user.organizationId === 'default-org') {
            Alert.alert('No Organization', "Your account isn't linked to an organization. Please contact support.");
            return;
        }
        const config = PLAN_CONFIG[selectedPlan];
        if (!subs[config.productId]) {
            Alert.alert(
                'Subscriptions Unavailable',
                'We could not load subscription plans from the App Store. Please check your connection and try again.'
            );
            return;
        }
        if (purchaseInFlight.current) return;
        purchaseInFlight.current = true;
        setLoading(true);
        try {
            // Opens the App Store sheet. The result arrives in handlePurchase or
            // handlePurchaseError, which clear the spinner.
            await purchaseSubscription(config.productId);
        } catch (error) {
            logger.error('Purchase request error:', error);
            if (!isUserCancelledError(error)) {
                Alert.alert('Purchase Failed', 'Unable to start purchase. Please try again.');
            }
            setLoading(false);
            purchaseInFlight.current = false;
        }
    };

    const handleRestorePurchases = async () => {
        setLoading(true);
        try {
            const purchases = await fetchAvailablePurchases();
            const ours = purchases.filter((p) => isOurProduct(p.productId));
            if (!ours.length) {
                Alert.alert('No Subscription Found', 'No active subscription was found for this account.');
                return;
            }
            const latest = ours.sort((a, b) => (b.transactionDate || 0) - (a.transactionDate || 0))[0];
            const jws = latest.purchaseToken;
            if (!jws) {
                Alert.alert('Restore Issue', 'Could not read purchase proof from the App Store. Please try again.');
                return;
            }
            const result = await validateReceiptWithServer(jws, latest.productId);
            if (!result.valid) {
                Alert.alert('Restore Failed', result.reason ?? 'We could not verify your existing purchase. Please contact support.');
                return;
            }
            await finishPurchase(latest);
            await refreshProfile();
            Alert.alert('Restored', 'Your subscription has been restored.');
        } catch (error) {
            logger.error('Restore error:', error);
            Alert.alert('Error', 'Unable to restore purchases. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const hasProducts = Object.keys(subs).length > 0;
    const subscribeDisabled = loading || !hasProducts || !subs[PLAN_CONFIG[selectedPlan].productId];

    return (
        <ScrollView contentContainerStyle={styles.container}>
            <View style={styles.header}>
                <MaterialCommunityIcons name="shield-star" size={56} color={theme.colors.primary} />
                <Text style={styles.title}>{isActive ? 'SUBSCRIPTION PLANS' : 'CHOOSE YOUR PLAN'}</Text>
                <Text style={styles.brandLine}>HolyGuard by Cowboy State</Text>
                <Text style={styles.subtitle}>
                    {isActive
                        ? 'Your organization has active access. These are the available plans.'
                        : 'Subscribe to start protecting your community.'}
                </Text>
            </View>

            {loadingProducts ? (
                <ActivityIndicator size="large" color={theme.colors.primary} style={{ marginVertical: 40 }} />
            ) : productsUnavailable || !hasProducts ? (
                <View style={styles.errorBox}>
                    <MaterialCommunityIcons name="alert-circle" size={28} color={theme.colors.error} />
                    <Text style={styles.errorTitle}>Plans unavailable</Text>
                    <Text style={styles.errorText}>
                        We could not load subscription plans from the App Store. Check your connection and tap Retry.
                    </Text>
                    <TouchableOpacity style={styles.retryButton} onPress={loadProducts}>
                        <Text style={styles.retryButtonText}>RETRY</Text>
                    </TouchableOpacity>
                </View>
            ) : (
                <View style={styles.plansContainer}>
                    <PlanCard
                        planKey="individual"
                        selected={selectedPlan === 'individual'}
                        onSelect={() => setSelectedPlan('individual')}
                        storeSub={subs[PLAN_CONFIG.individual.productId]}
                    />
                    <PlanCard
                        planKey="team"
                        selected={selectedPlan === 'team'}
                        onSelect={() => setSelectedPlan('team')}
                        storeSub={subs[PLAN_CONFIG.team.productId]}
                        popular
                    />
                    <PlanCard
                        planKey="enterprise"
                        selected={selectedPlan === 'enterprise'}
                        onSelect={() => setSelectedPlan('enterprise')}
                        storeSub={subs[PLAN_CONFIG.enterprise.productId]}
                    />
                </View>
            )}

            {isActive ? (
                <TouchableOpacity
                    style={styles.subscribeButton}
                    onPress={() => Linking.openURL(MANAGE_SUBSCRIPTIONS_URL)}
                >
                    <Text style={styles.subscribeButtonText}>MANAGE SUBSCRIPTION</Text>
                </TouchableOpacity>
            ) : (
                <>
                    <TouchableOpacity
                        style={[styles.subscribeButton, subscribeDisabled && styles.buttonDisabled]}
                        onPress={handleSubscribe}
                        disabled={subscribeDisabled}
                    >
                        {loading ? (
                            <ActivityIndicator color={theme.colors.textPrimary} />
                        ) : (
                            <Text style={styles.subscribeButtonText}>SUBSCRIBE NOW</Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity onPress={handleRestorePurchases} style={styles.restoreButton} disabled={loading}>
                        <Text style={styles.restoreText}>Restore Purchases</Text>
                    </TouchableOpacity>
                </>
            )}

            <Text style={styles.disclaimer}>
                HolyGuard subscriptions are auto-renewable. Each plan renews monthly at the price shown above (Individual $9.99/mo, Team $49.99/mo, Enterprise $99.99/mo) and provides the listed seats and features for the subscription period. Payment is charged to your Apple ID at confirmation of purchase. Subscriptions automatically renew unless cancelled at least 24 hours before the end of the current period. You can manage and cancel your subscription anytime in your Apple ID account settings.
            </Text>

            <View style={styles.legalLinks}>
                <TouchableOpacity onPress={() => Linking.openURL(TERMS_URL)}>
                    <Text style={styles.legalLinkText}>Terms of Use (EULA)</Text>
                </TouchableOpacity>
                <Text style={styles.legalLinkSeparator}>·</Text>
                <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_URL)}>
                    <Text style={styles.legalLinkText}>Privacy Policy</Text>
                </TouchableOpacity>
            </View>
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flexGrow: 1,
        backgroundColor: theme.colors.background,
        padding: theme.spacing.l,
        paddingTop: 60,
    },
    header: {
        alignItems: 'center',
        marginBottom: 24,
    },
    title: {
        fontSize: 22,
        fontWeight: '900',
        color: theme.colors.textPrimary,
        letterSpacing: 2,
        marginTop: 12,
    },
    brandLine: {
        fontSize: 14,
        fontWeight: '700',
        color: theme.colors.accent,
        letterSpacing: 1,
        marginTop: 6,
    },
    subtitle: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 8,
        lineHeight: 20,
        paddingHorizontal: 10,
    },
    plansContainer: {
        gap: 12,
        marginBottom: 24,
    },
    planCard: {
        backgroundColor: theme.colors.white,
        borderRadius: 12,
        padding: 16,
        borderWidth: 2,
        borderColor: theme.colors.border,
        position: 'relative',
    },
    planCardSelected: {
        borderColor: theme.colors.primary,
        backgroundColor: theme.colors.background,
    },
    planCardPopular: {
        borderColor: theme.colors.accent,
    },
    popularBadge: {
        position: 'absolute',
        top: -10,
        right: 16,
        backgroundColor: theme.colors.accent,
        paddingHorizontal: 10,
        paddingVertical: 3,
        borderRadius: 10,
    },
    popularBadgeText: {
        color: theme.colors.white,
        fontSize: 10,
        fontWeight: '900',
        letterSpacing: 1,
    },
    planHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    planName: {
        fontSize: 18,
        fontWeight: '900',
        color: theme.colors.textPrimary,
    },
    planNameSelected: {
        color: theme.colors.primary,
    },
    planPrice: {
        fontSize: 18,
        fontWeight: '900',
        color: theme.colors.textPrimary,
    },
    planPriceSelected: {
        color: theme.colors.primary,
    },
    planDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 10,
    },
    planFeatures: {
        gap: 6,
    },
    featureRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    featureText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginLeft: 8,
    },
    radioOuter: {
        position: 'absolute',
        top: 16,
        left: 16,
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.border,
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
    subscribeButton: {
        backgroundColor: theme.colors.primary,
        padding: 16,
        borderRadius: 8,
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 3,
    },
    buttonDisabled: {
        opacity: 0.5,
    },
    subscribeButtonText: {
        color: theme.colors.textPrimary,
        fontWeight: '900',
        fontSize: 16,
        letterSpacing: 1,
    },
    restoreButton: {
        alignItems: 'center',
        marginTop: 16,
    },
    restoreText: {
        color: theme.colors.primary,
        fontSize: 14,
        fontWeight: '600',
    },
    disclaimer: {
        fontSize: 11,
        color: theme.colors.gray,
        textAlign: 'center',
        marginTop: 16,
        lineHeight: 16,
        paddingHorizontal: 10,
    },
    legalLinks: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 12,
    },
    legalLinkText: {
        fontSize: 12,
        color: theme.colors.primary,
        fontWeight: '600',
        textDecorationLine: 'underline',
    },
    legalLinkSeparator: {
        fontSize: 12,
        color: theme.colors.gray,
        marginHorizontal: 8,
    },
    errorBox: {
        backgroundColor: theme.colors.white,
        borderRadius: 12,
        padding: 24,
        alignItems: 'center',
        marginBottom: 24,
        borderWidth: 1,
        borderColor: theme.colors.border,
    },
    errorTitle: {
        fontSize: 16,
        fontWeight: '900',
        color: theme.colors.textPrimary,
        marginTop: 8,
        marginBottom: 6,
    },
    errorText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 16,
        lineHeight: 18,
    },
    retryButton: {
        backgroundColor: theme.colors.primary,
        paddingHorizontal: 24,
        paddingVertical: 10,
        borderRadius: 8,
    },
    retryButtonText: {
        color: theme.colors.textPrimary,
        fontWeight: '900',
        fontSize: 13,
        letterSpacing: 1,
    },
});
