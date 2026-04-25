import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  gaqlSearch,
  gadsMutate,
  formatCurrency,
  formatPercent,
  truncateIfNeeded,
} from "../services/google-ads-client.js";
import {
  DateRangeSchema,
  buildDateClause,
  StatusFilterSchema,
  UpdateStatusSchema,
  LimitSchema,
} from "../schemas/common.js";
import type { GoogleAdsConfig, ToolResponse } from "../types.js";

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateIfNeeded(text) }] };
}
function err(text: string): ToolResponse {
  return { content: [{ type: "text", text: `❌ Error: ${text}` }], isError: true };
}

export function registerAdTools(
  server: McpServer,
  getConfig: () => GoogleAdsConfig
): void {

  // ── List Ads ────────────────────────────────────────────────────────────────
  server.registerTool(
    "gads_list_ads",
    {
      title: "List Ads",
      description: `List ads in your Google Ads account with status and performance metrics.

Returns ad ID, type, headlines/descriptions (for RSAs), status, final URLs, and metrics.

Args:
  - campaignId: (optional) filter to a specific campaign
  - adGroupId: (optional) filter to a specific ad group
  - statusFilter: "ENABLED" | "PAUSED" | "REMOVED" | "ALL" (default: "ENABLED")
  - dateRange: date range for metrics (default LAST_30_DAYS)
  - limit: max rows (default 50)

Returns: Markdown list of ads with metrics.`,
      inputSchema: z.object({
        campaignId: z.string().optional().describe("Filter to a specific campaign ID."),
        adGroupId: z.string().optional().describe("Filter to a specific ad group ID."),
        statusFilter: StatusFilterSchema,
        dateRange: DateRangeSchema.optional(),
        limit: LimitSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ campaignId, adGroupId, statusFilter, dateRange, limit }) => {
      try {
        const config = getConfig();
        const dateWhere = buildDateClause(dateRange);
        const campaignWhere = campaignId ? `AND campaign.id = '${campaignId}'` : "";
        const adGroupWhere = adGroupId ? `AND ad_group.id = '${adGroupId}'` : "";
        const statusWhere = statusFilter === "ALL" ? "" : `AND ad_group_ad.status = '${statusFilter}'`;

        const query = `
          SELECT
            ad_group_ad.ad.id,
            ad_group_ad.ad.type,
            ad_group_ad.ad.name,
            ad_group_ad.ad.final_urls,
            ad_group_ad.ad.responsive_search_ad.headlines,
            ad_group_ad.ad.responsive_search_ad.descriptions,
            ad_group_ad.ad.responsive_search_ad.path1,
            ad_group_ad.ad.responsive_search_ad.path2,
            ad_group_ad.ad.expanded_text_ad.headline_part1,
            ad_group_ad.ad.expanded_text_ad.headline_part2,
            ad_group_ad.ad.expanded_text_ad.description,
            ad_group_ad.status,
            ad_group.id,
            ad_group.name,
            campaign.id,
            campaign.name,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.ctr,
            metrics.average_cpc,
            metrics.conversions
          FROM ad_group_ad
          WHERE ${dateWhere} ${campaignWhere} ${adGroupWhere} ${statusWhere}
          ORDER BY metrics.impressions DESC
          LIMIT ${limit}
        `.trim();

        const rows = await gaqlSearch(config, query);

        if (rows.length === 0) {
          return ok(`No ads found with status: ${statusFilter}`);
        }

        const lines: string[] = [`## Ads (${rows.length} returned)`, ""];

        for (const row of rows) {
          const aa = row.adGroupAd as Record<string, unknown>;
          const ad = aa.ad as Record<string, unknown>;
          const rsa = ad.responsiveSearchAd as Record<string, unknown> | undefined;
          const eta = ad.expandedTextAd as Record<string, string> | undefined;
          const ag = row.adGroup as Record<string, string>;
          const c = row.campaign as Record<string, string>;
          const m = row.metrics as Record<string, string | number> | undefined;
          const urls = ad.finalUrls as string[] | undefined;

          lines.push(`### Ad ID: ${ad.id} (${ad.type})`);
          lines.push(`**Campaign:** ${c.name} | **Ad Group:** ${ag.name} | **Status:** ${aa.status}`);

          if (rsa) {
            const headlines = (rsa.headlines as Array<{ text: string }> | undefined) ?? [];
            const descs = (rsa.descriptions as Array<{ text: string }> | undefined) ?? [];
            lines.push(`**Headlines:** ${headlines.map((h) => h.text).join(" | ")}`);
            lines.push(`**Descriptions:** ${descs.map((d) => d.text).join(" | ")}`);
            const path1 = rsa.path1 as string | undefined;
            const path2 = rsa.path2 as string | undefined;
            if (path1 || path2) lines.push(`**Display Path:** /${path1 ?? ""}/${path2 ?? ""}`);
          } else if (eta) {
            lines.push(`**Headline:** ${eta.headlinePart1} | ${eta.headlinePart2}`);
            lines.push(`**Description:** ${eta.description}`);
          }

          if (urls && urls.length > 0) lines.push(`**URL:** ${urls[0]}`);
          lines.push(
            `**Metrics:** ${Number(m?.impressions ?? 0).toLocaleString()} impr | ` +
            `${Number(m?.clicks ?? 0).toLocaleString()} clicks | ` +
            `${formatPercent(Number(m?.ctr ?? 0))} CTR | ` +
            `${formatCurrency(m?.costMicros)} cost | ` +
            `${formatCurrency(m?.averageCpc)} CPC | ` +
            `${Number(m?.conversions ?? 0).toFixed(1)} conv`
          );
          lines.push("");
        }

        return ok(lines.join("\n"));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Create Responsive Search Ad ─────────────────────────────────────────────
  server.registerTool(
    "gads_create_responsive_search_ad",
    {
      title: "Create Responsive Search Ad",
      description: `Create a new Responsive Search Ad (RSA) in an ad group.

RSAs are the standard Google Ads text ad format — you supply up to 15 headlines and 4 descriptions; Google optimises combinations automatically.

Requirements:
  - Minimum 3 headlines (max 15, each ≤ 30 chars)
  - Minimum 2 descriptions (max 4, each ≤ 90 chars)
  - At least one final URL

Args:
  - adGroupId: Ad group ID to create the ad in
  - headlines: Array of headline strings (3–15, max 30 chars each)
  - descriptions: Array of description strings (2–4, max 90 chars each)
  - finalUrl: The landing page URL
  - path1: (optional) Display URL path 1 (max 15 chars)
  - path2: (optional) Display URL path 2 (max 15 chars, requires path1)

Returns: Confirmation with new ad resource name.

Examples:
  - "Create an ad in ad group 456 with headlines [Buy Now, Shop Today, Great Deals] and descriptions [Save up to 50%, Order today and save]"`,
      inputSchema: z.object({
        adGroupId: z.string().describe("Ad group ID to create the ad in."),
        headlines: z
          .array(z.string().max(30, "Headline must be ≤30 chars"))
          .min(3, "Minimum 3 headlines required")
          .max(15, "Maximum 15 headlines allowed")
          .describe("Array of 3–15 headlines (max 30 chars each)."),
        descriptions: z
          .array(z.string().max(90, "Description must be ≤90 chars"))
          .min(2, "Minimum 2 descriptions required")
          .max(4, "Maximum 4 descriptions allowed")
          .describe("Array of 2–4 descriptions (max 90 chars each)."),
        finalUrl: z.string().url().describe("Landing page URL."),
        path1: z.string().max(15).optional().describe("Display URL path 1 (optional, max 15 chars)."),
        path2: z.string().max(15).optional().describe("Display URL path 2 (optional, max 15 chars, requires path1)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ adGroupId, headlines, descriptions, finalUrl, path1, path2 }) => {
      try {
        const config = getConfig();
        const cid = config.customerId.replace(/-/g, "");
        const adGroupResourceName = `customers/${cid}/adGroups/${adGroupId}`;

        const ad: Record<string, unknown> = {
          finalUrls: [finalUrl],
          responsiveSearchAd: {
            headlines: headlines.map((text) => ({ text })),
            descriptions: descriptions.map((text) => ({ text })),
            ...(path1 ? { path1 } : {}),
            ...(path2 ? { path2 } : {}),
          },
          type: "RESPONSIVE_SEARCH_AD",
        };

        const result = await gadsMutate(config, "adGroupAds", [
          {
            create: {
              adGroup: adGroupResourceName,
              status: "PAUSED", // Best practice: create paused, review, then enable
              ad,
            },
          },
        ]);

        return ok(
          `✅ Responsive Search Ad created in ad group ${adGroupId}.\n` +
          `Resource: ${result.results[0]?.resourceName ?? "(unknown)"}\n\n` +
          `⚠️  Ad was created with status **PAUSED** — review it in Google Ads UI and enable when ready.\n\n` +
          `**Headlines:** ${headlines.join(" | ")}\n` +
          `**Descriptions:** ${descriptions.join(" | ")}\n` +
          `**URL:** ${finalUrl}`
        );
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Update Ad Status ────────────────────────────────────────────────────────
  server.registerTool(
    "gads_update_ad_status",
    {
      title: "Update Ad Status",
      description: `Pause, enable, or remove a specific ad.

Args:
  - adGroupId: Ad group ID containing the ad
  - adId: Ad ID
  - status: "ENABLED" | "PAUSED" | "REMOVED"

Returns: Confirmation message.`,
      inputSchema: z.object({
        adGroupId: z.string().describe("Ad group ID."),
        adId: z.string().describe("Ad ID."),
        status: UpdateStatusSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ adGroupId, adId, status }) => {
      try {
        const config = getConfig();
        const cid = config.customerId.replace(/-/g, "");
        const resourceName = `customers/${cid}/adGroupAds/${adGroupId}~${adId}`;

        await gadsMutate(config, "adGroupAds", [
          { update: { resourceName, status }, updateMask: "status" },
        ]);

        return ok(`✅ Ad ${adId} status updated to **${status}**.`);
      } catch (e) {
        return err(String(e));
      }
    }
  );
}
