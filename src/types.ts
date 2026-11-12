export interface Alert {
    id: string;
    title: string;
    location: string;
    organizationId?: string; // the org's id field ('org_<ms>'), as the rules require on every alert
    timestamp: string; // ISO string or relative time for display
    type: 'alert' | 'warning' | 'info';
    category?: string; // Incident type: Trespass, Theft, etc.
    details?: string;
    imageUrl?: string; // Legacy single image (backward compat)
    imageUrls?: string[]; // Multiple photos
    description?: string;
    reporterName?: string;
    reporterId?: string;
    latitude?: number;
    longitude?: number;
    updatedAt?: any;
    updatedBy?: string;
    updatedByName?: string;
    alertLevel?: 'yellow' | 'red';
    policeIncidentNumber?: string;
}

export interface WatchlistEntry {
    id: string;
    name: string;
    licensePlate?: string;
    physicalDescription?: string;
    status: 'active' | 'resolved' | 'monitoring';
    date: string;
    location?: string;
    latitude?: number;
    longitude?: number;
    imageUrls: string[];
    organizationId: string;
    createdBy: string;
    createdByName?: string;
    linkedAlertId?: string;
    createdAt: any;
    updatedAt?: any;
    notes?: string;
}

export type SubscriptionPlan = 'individual' | 'team' | 'enterprise';
export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';

export interface UserProfile {
    id: string;
    name: string;
    role: 'admin' | 'security' | 'member' | 'super_admin';
    organizationId: string;
    emailVerified: boolean;
    organizationStatus?: 'pending' | 'verified' | 'rejected';
    organizationName?: string;
    tosAcceptedAt?: string;
    subscriptionPlan?: SubscriptionPlan;
    subscriptionStatus?: SubscriptionStatus;
    maxSeats?: number;
    // uids this user has blocked (users/{uid}.blockedUsers, written only by the user).
    // Screens that filter content read the profile doc live; this copy is as of the
    // last profile load.
    blockedUsers?: string[];
}

export interface VerificationCheck {
    status: 'pending' | 'passed' | 'failed' | 'skipped';
    score: number;
    details?: string;
    checkedAt?: any;
}

export interface VerificationChecks {
    googlePlaces: VerificationCheck & { placeId?: string };
    einVerification: VerificationCheck & { nonprofitName?: string };
    emailDomain: VerificationCheck & { domain?: string };
    phoneSms: VerificationCheck;
    totalScore: number;
    autoApproved: boolean;
    reviewedBy?: string;
    reviewedAt?: any;
}
