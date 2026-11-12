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
    billingPeriodLabel,
    isMonthlyPlan,
    pricePerSeat,
    type PlanKey,
} from '../config/iap';
import {
    FUNCTIONS_BASE_URL,
    MANAGE_SUBSCRIPTIONS_URL,
    PRIVACY_URL,
    SUPPORT_EMAIL,
    TERMS_URL,
} from '../constants/links';
import { AccountActions } from '../components/AccountActions';
import { logger } from '../utils/logger';

const VALIDATE_RECEIPT_URL = `${FUNCTIONS_BASE_URL}/validateAppleReceipt`;

const PLAN_ORDER: PlanKey[] = ['individual', 'team', 'enterprise'];

const isOurProduct = (productId: string) => Object.values(PRODUCT_IDS).includes(productId);

// Open a link; if no app can open it, show the address instead.
const openLink = async (url: string, title: string) => {
    try {
        await Linking.openURL(url);
    } catch (error) {
        logger.warn(`Open ${title} failed:`, error);
        Alert.alert(title, url);
    }
};

// The auto-renewal disclosure (Guideline 3.1.2), with each plan's price and period taken
// from the App Store so it always matches what StoreKit charges in this storefront.
const buildDisclaimer = (subs: Record<string, ProductSubscription>): string => {
    const loaded = PLAN_ORDER.map((key) => ({ key, product: subs[PLAN_CONFIG[key].productId] })).filter(
        (entry): entry is { key: PlanKey; product: ProductSubscription } => !!entry.product?.displayPrice
    );
    const renewal = loaded.every((entry) => isMonthlyPlan(entry.product))
        ? 'Each plan renews monthly'
        : 'Each plan renews at the end of its billing period';
    const prices = loaded.length
        ? ` at the price shown above (${loaded
              .map((entry) => `${PLAN_CONFIG[entry.key].name} ${entry.product.displayPrice}/${billingPeriodLabel(entry.product)}`)
              .join(', ')})`
        : ' at the price the App Store shows before you confirm the purchase';
    return (
        `HolyGuard subscriptions are auto-renewable. ${renewal}${prices} and provides the listed seats and features ` +
        'for the subscription period. Payment is charged to your Apple ID at confirmation of purchase. Subscriptions ' +
        'automatically renew unless cancelled at least 24 hours before the end of the current period. You can manage ' +
        'and cancel your subscription anytime in your Apple ID account settings.'
    );
};

// What to tell the admin when validateAppleReceipt (functions/index.js) rejects a purchase
// for a reason that retrying cannot fix. undefined: the failure was temporary (network, 5xx).
const permanentRejectionMessage = (status: number, error: unknown): string | undefined => {
    if (status === 403) return 'Only an organization admin can activate a subscription.';
    if (status === 404) return `Your account isn't linked to an organization. Please contact support at ${SUPPORT_EMAIL}.`;
    if (status === 409) {
        return typeof error === 'string' && error
            ? error
            : `This organization already has an active App Store subscription from another Apple ID. Contact support at ${SUPPORT_EMAIL} if you need to change who pays.`;
    }
    if (status !== 200 || typeof error !== 'string') return undefined;
    if (error.includes('already linked')) {
        return `This Apple ID's HolyGuard subscription is already linked to another organization. Use the Apple ID that pays for this organization, or contact support at ${SUPPORT_EMAIL}.`;
    }
    if (error === 'Subscription expired') return 'This subscription has expired. Choose a plan to subscribe again.';
    if (error === 'Subscription revoked') return 'Apple refunded or revoked this purchase. Choose a plan to subscribe again.';
    return `The App Store purchase could not be verified for HolyGuard. Please contact support at ${SUPPORT_EMAIL}.`;
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
    // Price and period come from the App Store. A plan StoreKit did not return can't be
    // bought, so it shows no price rather than a guessed one.
    const displayPrice = storeSub?.displayPrice || null;
    const period = billingPeriodLabel(storeSub);
    const monthly = isMonthlyPlan(storeSub);
    const perSeat = displayPrice && seats > 1 ? pricePerSeat(storeSub, seats) : null;

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
                {displayPrice ? (
                    <Text style={[styles.planPrice, selected && styles.planPriceSelected]}>
                        {displayPrice}
                        <Text style={styles.planPeriod}> / {period}</Text>
                    </Text>
                ) : (
                    <Text style={styles.planUnavailable}>Not available</Text>
                )}
            </View>
            <Text style={styles.planDescription}>{config.description}</Text>
            <View style={styles.planFeatures}>
                {displayPrice && (
                    <View style={styles.featureRow}>
                        <MaterialCommunityIcons name="calendar-sync" size={16} color={selected ? theme.colors.primary : theme.colors.textSecondary} />
                        <Text style={styles.featureText}>
                            {monthly
                                ? 'Monthly subscription, renews automatically'
                                : `Renews automatically every ${period}`}
                        </Text>
                    </View>
                )}
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
                {perSeat && (
                    <View style={styles.featureRow}>
                        <MaterialCommunityIcons name="cash" size={16} color={selected ? theme.colors.primary : theme.colors.textSecondary} />
                        <Text style={styles.featureText}>
                            {monthly ? `${perSeat}/seat/mo` : `${perSeat} per seat every ${period}`}
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
    // Set once validateActivePurchase has run against a live StoreKit connection.
    const activePurchaseChecked = useRef(false);

    // For an unpaid org the purchase listeners are registered once. They attach as soon as the
    // StoreKit connection is up: now, or after a later Retry connects (src/config/iap.ts). They
    // keep this first render's handlers, which only use state setters, refs, auth and
    // refreshProfile. An active org (Settings → Subscription Plans) only sees the plans: nothing
    // is bought here. validateAppleReceipt leaves a grandfathered org's plan and seats alone
    // (it records only the Apple link), but there is still nothing to activate for an org that
    // is already active, so no purchase is validated from here.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            let ready = false;
            try {
                ready = await initIAP();
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
                if (ready) validateActivePurchase();
            }
            // If the connection failed, this makes one fresh attempt (initIAP() does not keep
            // a failed one); after that, Retry tries again.
            const loaded = await loadProducts();
            if (cancelled) return;
            if (!isActive && loaded) validateActivePurchase();
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

    // Loads the plans from the App Store. fetchSubscriptionProducts waits for initIAP(), which
    // starts a fresh connection attempt if the last one failed. Resolves true when plans loaded.
    const loadProducts = async (): Promise<boolean> => {
        setLoadingProducts(true);
        setProductsUnavailable(false);
        try {
            const products = await fetchSubscriptionProducts();
            if (!products.length) {
                setProductsUnavailable(true);
                setSubs({});
                return false;
            }
            const productMap: Record<string, ProductSubscription> = {};
            for (const product of products) {
                productMap[product.id] = product;
            }
            setSubs(productMap);
            return true;
        } catch (error) {
            logger.error('Load products error:', error);
            setProductsUnavailable(true);
            setSubs({});
            return false;
        } finally {
            setLoadingProducts(false);
        }
    };

    // "Plans unavailable" → Retry. Reconnects to the App Store if needed; once it is connected
    // the purchase listeners attach by themselves, and an unpaid org gets the entitlement check
    // it missed on open.
    const handleRetry = async () => {
        const loaded = await loadProducts();
        if (loaded && !isActive) validateActivePurchase();
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
    // Runs once per screen, and only against a live connection (without one,
    // fetchAvailablePurchases would just report nothing).
    const validateActivePurchase = async () => {
        try {
            if (!(await initIAP())) return;
            if (activePurchaseChecked.current) return;
            activePurchaseChecked.current = true;
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
            Alert.alert('No Organization', `Your account isn't linked to an organization. Please contact support at ${SUPPORT_EMAIL}.`);
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
            // Without a connection fetchAvailablePurchases reports nothing, which would read
            // as "no subscription". initIAP() retries a failed connection.
            if (!(await initIAP())) {
                Alert.alert('App Store Unavailable', 'We could not connect to the App Store. Check your connection and try again.');
                return;
            }
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
                Alert.alert(
                    'Restore Failed',
                    result.reason ?? `We could not verify your existing purchase. Please contact support at ${SUPPORT_EMAIL}.`
                );
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
                    <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
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
                    onPress={() => openLink(MANAGE_SUBSCRIPTIONS_URL, 'Manage Subscription')}
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

            <Text style={styles.disclaimer}>{buildDisclaimer(subs)}</Text>

            <View style={styles.legalLinks}>
                <TouchableOpacity onPress={() => openLink(TERMS_URL, 'Terms of Use')} accessibilityRole="link">
                    <Text style={styles.legalLinkText}>Terms of Use (EULA)</Text>
                </TouchableOpacity>
                <Text style={styles.legalLinkSeparator}>·</Text>
                <TouchableOpacity onPress={() => openLink(PRIVACY_URL, 'Privacy Policy')} accessibilityRole="link">
                    <Text style={styles.legalLinkText}>Privacy Policy</Text>
                </TouchableOpacity>
            </View>

            {/* Root gate only: an admin who doesn't subscribe can still sign out or delete
                the account. The informational mode (Settings → Subscription Plans) has both in Settings. */}
            {!isActive && <AccountActions style={styles.accountActions} />}
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
        // Room for the radio button (absolutely positioned at left 16) so it doesn't cover the name.
        paddingLeft: 48,
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
        flexShrink: 1,
    },
    planNameSelected: {
        color: theme.colors.primary,
    },
    planPrice: {
        fontSize: 18,
        fontWeight: '900',
        color: theme.colors.textPrimary,
        flexShrink: 1,
        marginLeft: 8,
        textAlign: 'right',
    },
    planPriceSelected: {
        color: theme.colors.primary,
    },
    planPeriod: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    planUnavailable: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        marginLeft: 8,
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
    accountActions: {
        marginTop: 20,
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
