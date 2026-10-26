/**
 * In-app subscriptions through StoreKit 2 (react-native-iap v15, Nitro).
 *
 * Mirrors the live v1.2.7 module. Rules that keep the app from crashing:
 * - Every call into react-native-iap waits for initIAP() first. Calling the
 *   library (fetchProducts, purchaseUpdatedListener, purchaseErrorListener, ...)
 *   before initConnection() resolves raises a native exception that JS cannot
 *   catch; App Review hit that crash in an earlier build.
 * - initIAP() is memoized: every caller gets the same promise.
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

export const planFromProductId = (productId: string): PlanKey | null => {
  if (productId === PRODUCT_IDS.INDIVIDUAL) return 'individual';
  if (productId === PRODUCT_IDS.TEAM) return 'team';
  if (productId === PRODUCT_IDS.ENTERPRISE) return 'enterprise';
  return null;
};

// Shared by every caller. Cleared only when initConnection() throws, so the next
// call retries; a resolved result is kept for the rest of the session.
let initPromise: Promise<boolean> | null = null;

/** Start the StoreKit connection once. Never rejects: resolves false on failure. */
export const initIAP = (): Promise<boolean> => {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const connected = await initConnection();
      logger.log('IAP connection initialized');
      return !!connected;
    } catch (error) {
      logger.error('IAP init error:', error);
      initPromise = null;
      return false;
    }
  })();
  return initPromise;
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

// Returns a handle at once, but attaches the native listener only after initIAP()
// resolves true, and never after remove() was called.
const attachWhenReady = (
  attach: () => EventSubscription,
  label: string,
): EventSubscription => {
  let sub: EventSubscription | null = null;
  let cancelled = false;
  initIAP()
    .then((ready) => {
      if (cancelled || !ready) return;
      try {
        sub = attach();
      } catch (error) {
        logger.error(`${label} attach failed:`, error);
      }
    })
    .catch((error) => logger.error(`${label} init failed:`, error));
  return {
    remove: () => {
      cancelled = true;
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
