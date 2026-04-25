// Google Ads API version — bump here to upgrade across the whole server
export const GADS_API_VERSION = "v18";
export const GADS_BASE_URL = `https://googleads.googleapis.com/${GADS_API_VERSION}`;
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Response size guard
export const CHARACTER_LIMIT = 50_000;

// Campaign status enums (as used in the API)
export const CAMPAIGN_STATUS = {
  ENABLED: "ENABLED",
  PAUSED: "PAUSED",
  REMOVED: "REMOVED",
} as const;

export const AD_GROUP_STATUS = {
  ENABLED: "ENABLED",
  PAUSED: "PAUSED",
  REMOVED: "REMOVED",
} as const;

export const AD_STATUS = {
  ENABLED: "ENABLED",
  PAUSED: "PAUSED",
  REMOVED: "REMOVED",
} as const;

export const KEYWORD_STATUS = {
  ENABLED: "ENABLED",
  PAUSED: "PAUSED",
  REMOVED: "REMOVED",
} as const;

// Micros = actual value × 1,000,000 (Google Ads stores money in micros)
export const MICROS_DIVISOR = 1_000_000;
