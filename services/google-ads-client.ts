import axios, { AxiosInstance, AxiosError } from "axios";
import {
  GADS_BASE_URL,
  OAUTH_TOKEN_URL,
  CHARACTER_LIMIT,
  MICROS_DIVISOR,
} from "../constants.js";
import type {
  GoogleAdsConfig,
  GadsSearchRequest,
  GadsSearchResponse,
  MutateOperation,
  MutateResponse,
} from "../types.js";

// ─── Token Cache ──────────────────────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix ms
}

let tokenCache: CachedToken | null = null;

async function refreshAccessToken(config: GoogleAdsConfig): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await axios.post<{
    access_token: string;
    expires_in: number;
  }>(OAUTH_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  tokenCache = {
    accessToken: response.data.access_token,
    expiresAt: Date.now() + response.data.expires_in * 1000,
  };

  return tokenCache.accessToken;
}

// ─── Client Factory ───────────────────────────────────────────────────────────

async function createClient(config: GoogleAdsConfig): Promise<AxiosInstance> {
  const accessToken = await refreshAccessToken(config);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": config.developerToken,
    "Content-Type": "application/json",
  };

  if (config.loginCustomerId) {
    headers["login-customer-id"] = config.loginCustomerId;
  }

  return axios.create({
    baseURL: GADS_BASE_URL,
    headers,
    timeout: 30_000,
  });
}

// ─── Error Helper ─────────────────────────────────────────────────────────────

function extractGadsError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axErr = error as AxiosError<{
      error?: { details?: Array<{ errors?: Array<{ message?: string }> }> };
      message?: string;
    }>;
    const details = axErr.response?.data?.error?.details;
    if (details && details.length > 0) {
      const errors = details[0]?.errors;
      if (errors && errors.length > 0) {
        return errors.map((e) => e.message ?? "Unknown error").join("; ");
      }
    }
    return axErr.response?.data?.message ?? axErr.message ?? "Request failed";
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// ─── GAQL Search (paginated) ──────────────────────────────────────────────────

export async function gaqlSearch(
  config: GoogleAdsConfig,
  query: string,
  maxRows = 1000
): Promise<Record<string, unknown>[]> {
  const client = await createClient(config);
  const customerId = config.customerId.replace(/-/g, "");
  const allResults: Record<string, unknown>[] = [];
  let pageToken: string | undefined;

  do {
    const body: GadsSearchRequest = {
      query,
      pageSize: Math.min(maxRows - allResults.length, 1000),
      ...(pageToken ? { pageToken } : {}),
    };

    try {
      const response = await client.post<GadsSearchResponse>(
        `/customers/${customerId}/googleAds:search`,
        body
      );

      const rows = response.data.results ?? [];
      allResults.push(...rows);
      pageToken = response.data.nextPageToken;

      if (allResults.length >= maxRows) break;
    } catch (err) {
      throw new Error(`GAQL query failed: ${extractGadsError(err)}`);
    }
  } while (pageToken);

  return allResults;
}

// ─── Mutate Helper ────────────────────────────────────────────────────────────

export async function gadsMutate(
  config: GoogleAdsConfig,
  resource: string, // e.g. "campaigns", "adGroups", "adGroupCriteria"
  operations: MutateOperation[]
): Promise<MutateResponse> {
  const client = await createClient(config);
  const customerId = config.customerId.replace(/-/g, "");

  try {
    const response = await client.post<MutateResponse>(
      `/customers/${customerId}/${resource}:mutate`,
      { operations }
    );
    return response.data;
  } catch (err) {
    throw new Error(`Mutate ${resource} failed: ${extractGadsError(err)}`);
  }
}

// ─── Formatting Utilities ─────────────────────────────────────────────────────

export function microsToAmount(micros: string | number | undefined): number {
  if (micros === undefined || micros === null) return 0;
  return Number(micros) / MICROS_DIVISOR;
}

export function amountToMicros(amount: number): string {
  return String(Math.round(amount * MICROS_DIVISOR));
}

export function formatCurrency(
  micros: string | number | undefined,
  currency = "USD"
): string {
  const amount = microsToAmount(micros);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || value === null) return "0.00%";
  return `${(value * 100).toFixed(2)}%`;
}

export function truncateIfNeeded(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n... [TRUNCATED — response exceeded ${CHARACTER_LIMIT} chars. Use date filters or campaign filters to narrow results.]`
  );
}

export function buildResourceName(
  customerId: string,
  resource: string,
  id: string
): string {
  const cid = customerId.replace(/-/g, "");
  return `customers/${cid}/${resource}/${id}`;
}

// ─── Load config from env ─────────────────────────────────────────────────────

export function loadConfig(): GoogleAdsConfig {
  const required = [
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_CUSTOMER_ID",
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}\n` +
        `Set them in Railway environment variables or .env file.`
    );
  }

  return {
    clientId: process.env.GOOGLE_ADS_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN!,
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
    customerId: process.env.GOOGLE_ADS_CUSTOMER_ID!,
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  };
}
