/**
 * In-app subscriptions through StoreKit 2 (react-native-iap v15, Nitro).
 *
 * Mirrors the live v1.2.7 module. Rules that keep the app from crashing:
 * - Every call into react-native-iap waits for initIAP() first. Calling the
 *   library (fetchProducts, purchaseUpdatedListener, purchaseErrorListener, ...)
 *   before initConnection() resolves raises a native exception that JS cannot
 *   catch; App Review hit that crash in an earlier build.
 * - initIAP() is shared: callers get the attempt in flight, or the one that connected.
 *   A failed attempt is not kept, so a later call (the paywall's Retry) can recover.
 * - Never call endConnection(). teardownIAP() is a deliberate no-op.
 *
 * Purchases complete through purchaseUpdatedListener, not the requestPurchase
 * promise. Each iOS purchase carries its StoreKit 2 signed transaction (JWS) in
 * purchase.purchaseToken; the validateAppleReceipt Cloud Function verifies it and
 * writes the plan to the org. The client never writes the plan or its status.
 */
import {
  ErrorCode,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  getReceiptIOS,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  requestReceiptRefreshIOS,
} from 'react-native-iap';
import type {
  EventSubscription,
  ProductSubscription,
  Purchase,
  PurchaseError,
} from 'react-native-iap';
import { logger } from '../utils/logger';

export const PRODUCT_IDS = {
  INDIVIDUAL: '001',
  TEAM: '002',
  ENTERPRISE: '003',
};

export const PRODUCT_ID_LIST = [
  PRODUCT_IDS.INDIVIDUAL,
  PRODUCT_IDS.TEAM,
  PRODUCT_IDS.ENTERPRISE,
];

export const PLAN_CONFIG = {
  individual: {
    productId: PRODUCT_IDS.INDIVIDUAL,
    name: 'Individual',
    price: '$9.99/mo',
    seats: 3,
    description: 'Up to 3 team members',
  },
  team: {
    productId: PRODUCT_IDS.TEAM,
    name: 'Team',
    price: '$49.99/mo',
    seats: 15,
    description: 'Up to 15 team members',
  },
  enterprise: {
    productId: PRODUCT_IDS.ENTERPRISE,
    name: 'Enterprise',
    price: '$99.99/mo',
    seats: 30,
    description: 'Up to 30 team members',
  },
} as const;

export type PlanKey = keyof typeof PLAN_CONFIG;

// PLAN_CONFIG.price is the US price as configured in App Store Connect, kept for
// reference only. Screens show the App Store's own price (product.displayPrice), which
// follows the storefront's currency and any repricing.

// Every plan is a 1-month auto-renewable subscription in App Store Connect. Used only when
// StoreKit doesn't report the period.
const CONFIGURED_PERIOD = { unit: 'month', value: 1 } as const;

const PERIOD_UNITS = ['day', 'week', 'month', 'year'] as const;
type PeriodUnit = (typeof PERIOD_UNITS)[number];

/** The plan's billing period as StoreKit reports it, or the configured 1 month. */
export const billingPeriodOf = (
  product?: ProductSubscription | null,
): { unit: PeriodUnit; value: number } => {
  const ios = product && product.platform === 'ios' ? product : null;
  const unit = ios?.subscriptionPeriodUnitIOS;
  const value = Number(ios?.subscriptionPeriodNumberIOS ?? '');
  if (unit && (PERIOD_UNITS as readonly string[]).includes(unit) && Number.isInteger(value) && value > 0) {
    return { unit: unit as PeriodUnit, value };
  }
  return { ...CONFIGURED_PERIOD };
};

/** 'month', '3 months', 'year' ... for "$9.99 / month" and "per month". */
export const billingPeriodLabel = (product?: ProductSubscription | null): string => {
  const { unit, value } = billingPeriodOf(product);
  return value === 1 ? unit : `${value} ${unit}s`;
};

/** True when the plan renews every month (the configured period). */
export const isMonthlyPlan = (product?: ProductSubscription | null): boolean => {
  const { unit, value } = billingPeriodOf(product);
  return unit === 'month' && value === 1;
};

/**
 * The App Store price divided across the plan's seats, formatted in the storefront's
 * currency, e.g. '$3.33'. null when StoreKit gave no numeric price or the currency can't
 * be formatted, so the caller can leave the line out rather than guess.
 */
export const pricePerSeat = (product: ProductSubscription | null | undefined, seats: number): string | null => {
  const price = product?.price;
  const currency = product?.currency;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || !currency || seats < 1) {
    return null;
  }
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(price / seats);
  } catch (error) {
    logger.warn('pricePerSeat format failed:', error);
    return null;
  }
};

export const planFromProductId = (productId: string): PlanKey | null => {
  if (productId === PRODUCT_IDS.INDIVIDUAL) return 'individual';
  if (productId === PRODUCT_IDS.TEAM) return 'team';
  if (productId === PRODUCT_IDS.ENTERPRISE) return 'enterprise';
  return null;
};

// The attempt in flight, or the one that connected. Every caller shares it, so two
// initConnection() calls never run at the same time. A failed attempt is dropped once it
// settles, so the next initIAP() call (the paywall's Retry) tries again. In 15.6.2 the
// native initConnection() reports failure by resolving false, not by throwing, so both
// outcomes count as failure here.
let initPromise: Promise<boolean> | null = null;
let attemptedInit = false;
let connected = false;
// Run once, right after the first attempt that connects (see attachWhenReady).
const onConnected = new Set<() => void>();

const connectOnce = async (): Promise<boolean> => {
  try {
    const ok = (await initConnection()) === true;
    if (ok) {
      logger.log('IAP connection initialized');
    } else {
      logger.warn('IAP connection unavailable; the next initIAP() call retries');
    }
    return ok;
  } catch (error) {
    logger.error('IAP init error:', error);
    return false;
  }
};

/**
 * Start the StoreKit connection. Never rejects: resolves false on failure.
 * Once it has connected, every later call returns the same resolved promise. After a
 * failure the next call starts a fresh attempt; calls made while one is in flight share it.
 */
export const initIAP = (): Promise<boolean> => {
  if (initPromise) return initPromise;
  attemptedInit = true;
  const attempt = connectOnce();
  initPromise = attempt;
  // Registered before any caller can await `attempt`, so it runs first: by the time a
  // caller sees the result, a failed attempt is already cleared and listeners waiting for
  // the connection are already attached.
  attempt.then((ok) => {
    if (!ok) {
      if (initPromise === attempt) initPromise = null;
      return;
    }
    connected = true;
    const callbacks = Array.from(onConnected);
    onConnected.clear();
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        logger.error('IAP onConnected callback failed:', error);
      }
    }
  });
  return attempt;
};

/**
 * Deliberate no-op. Ending the connection mid-session breaks later IAP calls, so
 * nothing may call endConnection(), including effect cleanups.
 */
export const teardownIAP = async (): Promise<void> => {};

/** Load the three plans from the App Store. Returns [] when they cannot be loaded. */
export const fetchSubscriptionProducts = async (): Promise<ProductSubscription[]> => {
  const ready = await initIAP();
  if (!ready) {
    logger.warn('fetchSubscriptionProducts called before IAP ready');
    return [];
  }
  try {
    const products = await fetchProducts({ skus: PRODUCT_ID_LIST, type: 'subs' });
    const list = (products ?? []) as ProductSubscription[];
    logger.log(`Fetched ${list.length} subscription products from StoreKit`);
    return list;
  } catch (error) {
    logger.error('fetchSubscriptionProducts error:', error);
    return [];
  }
};

/**
 * Open the App Store purchase sheet. Resolves once the request is dispatched; the
 * outcome arrives through addPurchaseUpdateListener / addPurchaseErrorListener.
 */
export const purchaseSubscription = async (productId: string): Promise<void> => {
  const ready = await initIAP();
  if (!ready) {
    throw new Error('IAP not initialized');
  }
  await requestPurchase({
    request: {
      apple: { sku: productId },
      google: { skus: [productId] },
    },
    type: 'subs',
  });
};

/** Active purchases held by the App Store for this Apple ID (used by Restore). */
export const fetchAvailablePurchases = async (): Promise<Purchase[]> => {
  const ready = await initIAP();
  if (!ready) return [];
  return await getAvailablePurchases();
};

/**
 * Finish a transaction. Call only after validateAppleReceipt accepted it, so a purchase
 * that failed validation stays unfinished and can be validated again, by Restore
 * Purchases or by the paywall's check when it opens. StoreKit does not retry it on its
 * own: it replays an unfinished transaction once at launch, usually before any screen
 * is listening. Never throws.
 */
export const finishPurchase = async (purchase: Purchase): Promise<void> => {
  const ready = await initIAP();
  if (!ready) {
    logger.warn('finishPurchase called before IAP ready');
    return;
  }
  try {
    await finishTransaction({ purchase, isConsumable: false });
  } catch (error) {
    logger.error('Finish transaction error:', error);
  }
};

export const isUserCancelledError = (error: unknown): boolean =>
  (error as { code?: unknown } | null | undefined)?.code === ErrorCode.UserCancelled;

/** Ask to Buy and other purchases waiting for approval. The approved purchase arrives later. */
export const isDeferredPaymentError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === ErrorCode.DeferredPayment || code === ErrorCode.Pending;
};

// Returns a handle at once, but attaches the native listener only once an initIAP()
// attempt has connected, and never after remove() was called. If the first attempt
// failed, the listener stays waiting and attaches when a later attempt (Retry) connects.
const attachWhenReady = (
  attach: () => EventSubscription,
  label: string,
): EventSubscription => {
  let sub: EventSubscription | null = null;
  let cancelled = false;
  const tryAttach = () => {
    if (cancelled || sub) return;
    try {
      sub = attach();
    } catch (error) {
      logger.error(`${label} attach failed:`, error);
    }
  };
  if (connected) {
    tryAttach();
  } else {
    onConnected.add(tryAttach);
    // Start the connection if nothing has tried yet. After a failed attempt, retrying is
    // left to the caller (App.tsx at launch, the paywall's Retry), so attaching a listener
    // never fires an extra attempt on its own.
    if (!attemptedInit) initIAP();
  }
  return {
    remove: () => {
      cancelled = true;
      onConnected.delete(tryAttach);
      try {
        sub?.remove();
      } catch (error) {
        logger.warn(`${label} remove failed:`, error);
      }
    },
  };
};

// dedupeTransactionIOS: false. By default a transaction id reaches listeners once per
// connection session, so buying a plan this Apple ID already has, or buying again after a
// failed validation, would hand back an already-seen transaction and no event at all.
// The listener must therefore tolerate the same transaction twice.
export const addPurchaseUpdateListener = (
  listener: (purchase: Purchase) => void,
): EventSubscription =>
  attachWhenReady(
    () => purchaseUpdatedListener(listener, { dedupeTransactionIOS: false }),
    'purchaseUpdatedListener',
  );

export const addPurchaseErrorListener = (
  listener: (error: PurchaseError) => void,
): EventSubscription =>
  attachWhenReady(() => purchaseErrorListener(listener), 'purchaseErrorListener');

/** Legacy app-receipt read. Unused: the server validates the StoreKit 2 JWS instead. */
export const getAppReceipt = async (): Promise<string | null> => {
  const ready = await initIAP();
  if (!ready) {
    logger.warn('getAppReceipt called before IAP ready');
    return null;
  }
  try {
    return await getReceiptIOS();
  } catch (error) {
    logger.warn('Initial receipt read failed, attempting refresh:', error);
    try {
      return await requestReceiptRefreshIOS();
    } catch (refreshError) {
      logger.error('Receipt refresh error:', refreshError);
      return null;
    }
  }
};
