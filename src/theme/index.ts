export const theme = {
  colors: {
    // ───────────────────────────────────────────────
    // HolyGuard · Light Premium (facelift, locked 2026-10-18)
    // Cool off-white ground, charcoal chrome, restrained gold.
    // Skin-deep: same token KEYS as before, new values — so every
    // screen that reads from `theme.colors` reskins with no code change.
    // ───────────────────────────────────────────────
    background: '#EDEFF2',   // cool light grey      (was #D2B48C tan)
    surface:    '#FFFFFF',   // white cards          (was #E6D2B5)
    surfaceDark:'#1B1E24',   // charcoal app bar / contrast blocks (was #8B7355)

    textPrimary:   '#1B1E24', // near-black charcoal (was #2F2F2F)
    textSecondary: '#5B636F', // slate               (was #4A4A4A)
    textInverse:   '#FFFFFF', // on charcoal / gold chrome

    // Action — gold is the brand accent. On a gold fill use DARK text (textPrimary), never white.
    primary: '#B8901F', // deep gold, legible on white (was #8B4513 saddlebrown)
    accent:  '#5B636F', // brushed steel / slate       (was #556B2F olive)

    // New optional tokens the facelift introduces (nothing references them yet — safe to adopt gradually).
    gold:         '#B8901F', // = primary, named for clarity
    goldBright:   '#D4AF37', // badge gold, for accents ON charcoal/dark surfaces
    headerBg:     '#1B1E24', // charcoal top bar
    headerText:   '#FFFFFF',
    border:       '#E0E4EA', // hairline on white surfaces
    borderStrong: '#C9CFD7',
    accentBlue:   '#2E9BD6', // the badge's network-node blue, used sparingly

    // The red alert button — KEPT, nudged for contrast on white.
    danger: '#C62828', // (was #B22222)

    // Utility
    white: '#FFFFFF',
    black: '#000000',
    gray:  '#808080',

    // Status
    success: '#4CAF50',
    warning: '#FFC107',
    error:   '#F44336',

    // Incident category colors — unchanged (functional signals, not brand)
    incidentTrespass: '#e74c3c',
    incidentGraffiti: '#9b59b6',
    incidentTheft: '#e67e22',
    incidentAssault: '#c0392b',
    incidentSuspicious: '#8e44ad',
    incidentMedical: '#27ae60',
    incidentFire: '#d35400',
    incidentActiveThreat: '#B22222',
    incidentVandalism: '#34495e',
    incidentOther: '#7f8c8d',

    // Watchlist status colors — unchanged
    watchlistActive: '#e74c3c',
    watchlistMonitoring: '#e67e22',
    watchlistResolved: '#27ae60',

    // Alert level colors — unchanged
    alertYellow: '#F59E0B', // Amber

    // Verification status colors — unchanged
    verificationPending: '#F59E0B',  // Amber
    verificationVerified: '#10B981', // Green
    verificationRejected: '#EF4444', // Red
  },
  spacing: {
    s: 8,
    m: 16,
    l: 24,
    xl: 32,
  },
  text: {
    header: {
      fontSize: 24,
      fontWeight: '700' as const,
      color: '#1B1E24',
    },
    subHeader: {
      fontSize: 18,
      fontWeight: '600',
      color: '#5B636F',
    },
    body: {
      fontSize: 16,
      color: '#1B1E24',
    },
    caption: {
      fontSize: 12,
      color: '#5B636F',
    }
  }
};
