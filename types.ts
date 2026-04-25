// ─── Auth ────────────────────────────────────────────────────────────────────

export interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
}

export interface GoogleAdsConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  developerToken: string;
  customerId: string;       // 10-digit, hyphens stripped e.g. "1234567890"
  loginCustomerId?: string; // MCC account ID (if using a manager account)
}

// ─── GAQL Search ─────────────────────────────────────────────────────────────

export interface GadsSearchRequest {
  query: string;
  pageSize?: number;
  pageToken?: string;
}

export interface GadsSearchResponse {
  results: Record<string, unknown>[];
  nextPageToken?: string;
  totalResultsCount?: string;
}

// ─── Campaign ─────────────────────────────────────────────────────────────────

export interface CampaignRow {
  campaign: {
    id: string;
    name: string;
    status: string;
    advertisingChannelType: string;
    biddingStrategyType: string;
    resourceName: string;
  };
  campaignBudget?: {
    amountMicros: string;
    resourceName: string;
  };
  metrics?: CampaignMetrics;
}

export interface CampaignMetrics {
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  conversionsValue: number;
  ctr: number;
  averageCpc: string;
  allConversionsCostPerAction: number;
}

// ─── Ad Group ────────────────────────────────────────────────────────────────

export interface AdGroupRow {
  adGroup: {
    id: string;
    name: string;
    status: string;
    resourceName: string;
    cpcBidMicros?: string;
  };
  campaign: {
    id: string;
    name: string;
  };
  metrics?: AdGroupMetrics;
}

export interface AdGroupMetrics {
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  ctr: number;
  averageCpc: string;
}

// ─── Keyword ─────────────────────────────────────────────────────────────────

export interface KeywordRow {
  adGroupCriterion: {
    resourceName: string;
    criterionId: string;
    status: string;
    keyword: {
      text: string;
      matchType: string;
    };
    cpcBidMicros?: string;
    qualityInfo?: {
      qualityScore?: number;
    };
  };
  adGroup: {
    id: string;
    name: string;
  };
  campaign: {
    id: string;
    name: string;
  };
  metrics?: KeywordMetrics;
}

export interface KeywordMetrics {
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  ctr: number;
  averageCpc: string;
  costPerConversion: string;
  searchImpressionShare: number;
}

// ─── Ad ──────────────────────────────────────────────────────────────────────

export interface AdRow {
  adGroupAd: {
    resourceName: string;
    status: string;
    ad: {
      id: string;
      name?: string;
      type: string;
      responsiveSearchAd?: {
        headlines: Array<{ text: string; pinnedField?: string }>;
        descriptions: Array<{ text: string; pinnedField?: string }>;
        path1?: string;
        path2?: string;
      };
      expandedTextAd?: {
        headlinePart1: string;
        headlinePart2: string;
        headlinePart3?: string;
        description: string;
        description2?: string;
      };
      finalUrls: string[];
    };
  };
  adGroup: {
    id: string;
    name: string;
  };
  campaign: {
    id: string;
    name: string;
  };
  metrics?: AdMetrics;
}

export interface AdMetrics {
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  ctr: number;
  averageCpc: string;
}

// ─── Search Term ─────────────────────────────────────────────────────────────

export interface SearchTermRow {
  searchTermView: {
    searchTerm: string;
    status: string;
  };
  campaign: {
    id: string;
    name: string;
  };
  adGroup: {
    id: string;
    name: string;
  };
  metrics: SearchTermMetrics;
}

export interface SearchTermMetrics {
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  ctr: number;
  averageCpc: string;
  costPerConversion: string;
}

// ─── Mutate ──────────────────────────────────────────────────────────────────

export interface MutateOperation {
  update?: Record<string, unknown>;
  create?: Record<string, unknown>;
  remove?: string;
  updateMask?: string;
}

export interface MutateResponse {
  results: Array<{
    resourceName: string;
  }>;
}

// ─── Tool Response ────────────────────────────────────────────────────────────

// ─── Tool Response ─────────────────────────────────────────────────────────────
export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

export interface ToolContent_UNUSED {
  type: "text";
  text: string;
}

// (replaced by ToolResponse type above)
export interface ToolResponse_UNUSED {
  content: ToolContent_UNUSED[];
  isError?: boolean;
}
