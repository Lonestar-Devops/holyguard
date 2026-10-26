import Constants from 'expo-constants';

// Google Maps/Places API key for runtime HTTP calls (Places, Geocoding).
// Lives under `extra` in app.config.js: ios.config.* is stripped from the
// embedded manifest in release builds, so it cannot be read from there.
export const GOOGLE_PLACES_API_KEY: string =
  Constants.expoConfig?.extra?.googleMapsApiKey ?? '';

// Mapbox access token for map display.
export const MAPBOX_ACCESS_TOKEN: string =
  Constants.expoConfig?.extra?.mapboxAccessToken ?? '';
