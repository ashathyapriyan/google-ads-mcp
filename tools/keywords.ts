import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  gaqlSearch,
  gadsMutate,
  formatCurrency,
  formatPercent,
  microsToAmount,
  buildResourceName,
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

export function registerKeywordTools(
  server: McpServer,
  getConfig: () => GoogleAdsConfig
): void {

  // ── List Keywords ───────────────────────────────────────────────────────────
  server.registerTool(
    "gads_list_keywords",
    {
      title: "List Keywords",
      description: `List keywords in your Google Ads account with performance metrics.

Returns keyword text, match type, status, Quality Score, bid, and metrics (impressions, clicks, cost, CTR, CPC, conversions, CPA, impression share).

Args:
  - campaignId: (optional) filter to a specific campaign
  - adGroupId: (optional) filter to a specific ad group
  - statusFilter: "ENABLED" | "PAUSED" | "REMOVED" | "ALL" (default: "ENABLED")
  - dateRange: date range for metrics (default LAST_30_DAYS)
  - limit: max rows (default 100)

Returns: Markdown table of keywords.

Examples:
  - "List keywords in campaign 123" → campaignId="123"
  - "Show all paused keywords" → statusFilter="PAUSED"
  - "Which keywords got clicks last week?" → relativeDateRange="LAST_7_DAYS"`,
      inputSchema: z.object({
        campaignId: z.string().optional().describe("Filter to a specific campaign ID (optional)."),
        adGroupId: z.string().optional().describe("Filter to a specific ad group ID (optional)."),
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
        const statusWhere = statusFilter === "ALL" ? "" : `AND ad_group_criterion.status = '${statusFilter}'`;

        const query = `
          SELECT
            ad_group_criterion.criterion_id,
            ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type,
            ad_group_criterion.status,
            ad_group_criterion.quality_info.quality_score,
            ad_group_criterion.cpc_bid_micros,
            ad_group.id,
            ad_group.name,
            campaign.id,
            campaign.name,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.ctr,
            metrics.average_cpc,
            metrics.conversions,
            metrics.cost_per_conversion,
            metrics.search_impression_share
          FROM keyword_view
          WHERE ${dateWhere} ${campaignWhere} ${adGroupWhere} ${statusWhere}
            AND ad_group_criterion.type = 'KEYWORD'
          ORDER BY metrics.cost_micros DESC
          LIMIT ${limit}
        `.trim();

        const rows = await gaqlSearch(config, query);

        if (rows.length === 0) {
          return ok(`No keywords found with status: ${statusFilter}`);
        }

        const lines: string[] = [
          `## Keywords (${rows.length} returned)`,
          "",
          "| ID | Keyword | Match | Campaign | Ad Group | Status | QS | Bid | Impressions | Clicks | Cost | CTR | Avg CPC | Conv | CPA | IS |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
        ];

        for (const row of rows) {
          const k = row.adGroupCriterion as Record<string, unknown>;
          const kw = k.keyword as Record<string, string> | undefined;
          const qi = k.qualityInfo as Record<string, number> | undefined;
          const ag = row.adGroup as Record<string, string>;
          const c = row.campaign as Record<string, string>;
          const m = row.metrics as Record<string, string | number> | undefined;

          lines.push(
            `| ${k.criterionId} | ${kw?.text ?? "—"} | ${kw?.matchType ?? "—"} | ` +
            `${c.name} | ${ag.name} | ${k.status} | ` +
            `${qi?.qualityScore ?? "—"} | ${formatCurrency(k.cpcBidMicros as string)} | ` +
            `${Number(m?.impressions ?? 0).toLocaleString()} | ${Number(m?.clicks ?? 0).toLocaleString()} | ` +
            `${formatCurrency(m?.costMicros)} | ${formatPercent(Number(m?.ctr ?? 0))} | ` +
            `${formatCurrency(m?.averageCpc)} | ${Number(m?.conversions ?? 0).toFixed(1)} | ` +
            `${formatCurrency(m?.costPerConversion)} | ${formatPercent(Number(m?.searchImpressionShare ?? 0))} |`
          );
        }

        return ok(lines.join("\n"));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Update Keyword Status ───────────────────────────────────────────────────
  server.registerTool(
    "gads_update_keyword_status",
    {
      title: "Update Keyword Status",
      description: `Pause, enable, or remove a single keyword by its resource name or IDs.

Args:
  - adGroupId: Ad group ID containing the keyword
  - criterionId: Keyword criterion ID
  - status: "ENABLED" | "PAUSED" | "REMOVED"

Returns: Confirmation message.

Examples:
  - "Pause keyword 789 in ad group 456" → adGroupId="456", criterionId="789", status="PAUSED"`,
      inputSchema: z.object({
        adGroupId: z.string().describe("Ad group ID that contains the keyword."),
        criterionId: z.string().describe("Keyword criterion ID."),
        status: UpdateStatusSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ adGroupId, criterionId, status }) => {
      try {
        const config = getConfig();
        const cid = config.customerId.replace(/-/g, "");
        const resourceName = `customers/${cid}/adGroupCriteria/${adGroupId}~${criterionId}`;

        await gadsMutate(config, "adGroupCriteria", [
          { update: { resourceName, status }, updateMask: "status" },
        ]);

        return ok(`✅ Keyword (criterion ID: ${criterionId}) status updated to **${status}**.`);
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Update Keyword Bid ──────────────────────────────────────────────────────
  server.registerTool(
    "gads_update_keyword_bid",
    {
      title: "Update Keyword CPC Bid",
      description: `Change the max CPC bid for a keyword.

Args:
  - adGroupId: Ad group ID containing the keyword
  - criterionId: Keyword criterion ID
  - cpcBidAmount: New max CPC bid in account currency (e.g. 1.50 for $1.50)

Returns: Confirmation with new bid amount.`,
      inputSchema: z.object({
        adGroupId: z.string().describe("Ad group ID that contains the keyword."),
        criterionId: z.string().describe("Keyword criterion ID."),
        cpcBidAmount: z.number().positive().describe("New CPC bid in account currency (e.g. 1.50 = $1.50)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ adGroupId, criterionId, cpcBidAmount }) => {
      try {
        const config = getConfig();
        const cid = config.customerId.replace(/-/g, "");
        const resourceName = `customers/${cid}/adGroupCriteria/${adGroupId}~${criterionId}`;
        const cpcBidMicros = String(Math.round(cpcBidAmount * 1_000_000));

        await gadsMutate(config, "adGroupCriteria", [
          { update: { resourceName, cpcBidMicros }, updateMask: "cpc_bid_micros" },
        ]);

        return ok(
          `✅ Keyword ${criterionId} bid updated to **${formatCurrency(cpcBidMicros)}**.`
        );
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Bulk Pause Keywords by CPA ──────────────────────────────────────────────
  server.registerTool(
    "gads_bulk_pause_keywords_by_cpa",
    {
      title: "Bulk Pause Keywords by CPA Threshold",
      description: `Find all ENABLED keywords with cost-per-conversion (CPA) above a threshold and pause them in bulk.

This is a powerful automation tool — it identifies wasted spend and pauses underperforming keywords in one shot.

Args:
  - cpaThreshold: Pause keywords with CPA above this value (in account currency, e.g. 50 for £50)
  - minConversions: Minimum conversions required before considering CPA (default 1 — avoids pausing keywords with no data)
  - campaignId: (optional) limit to a specific campaign
  - dateRange: date range to evaluate CPA over (default LAST_30_DAYS)
  - dryRun: if true, only lists what would be paused WITHOUT actually pausing (default true for safety)

Returns: List of keywords that were (or would be) paused, with their CPA values.

Examples:
  - "Pause all keywords with CPA over £50" → cpaThreshold=50, dryRun=false
  - "Show me which keywords would be paused if CPA threshold is $30" → cpaThreshold=30, dryRun=true`,
      inputSchema: z.object({
        cpaThreshold: z
          .number()
          .positive()
          .describe("Pause keywords with CPA above this amount (in account currency)."),
        minConversions: z
          .number()
          .int()
          .min(0)
          .default(1)
          .describe("Minimum conversions required to evaluate CPA (default 1). Keywords with fewer conversions are skipped."),
        campaignId: z.string().optional().describe("Limit to a specific campaign ID (optional)."),
        dateRange: DateRangeSchema.optional(),
        dryRun: z
          .boolean()
          .default(true)
          .describe("If true (default), only LISTS what would be paused — does NOT pause. Set to false to actually pause."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ cpaThreshold, minConversions, campaignId, dateRange, dryRun }) => {
      try {
        const config = getConfig();
        const dateWhere = buildDateClause(dateRange);
        const campaignWhere = campaignId ? `AND campaign.id = '${campaignId}'` : "";

        const query = `
          SELECT
            ad_group_criterion.criterion_id,
            ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type,
            ad_group.id,
            ad_group.name,
            campaign.id,
            campaign.name,
            metrics.cost_micros,
            metrics.conversions,
            metrics.cost_per_conversion
          FROM keyword_view
          WHERE ${dateWhere} ${campaignWhere}
            AND ad_group_criterion.status = 'ENABLED'
            AND ad_group_criterion.type = 'KEYWORD'
            AND metrics.conversions >= ${minConversions}
          ORDER BY metrics.cost_per_conversion DESC
          LIMIT 1000
        `.trim();

        const rows = await gaqlSearch(config, query);

        // Filter to those over threshold
        const over = rows.filter((row) => {
          const m = row.metrics as Record<string, string | number> | undefined;
          const cpa = microsToAmount(String(m?.costPerConversion ?? 0));
          return cpa > cpaThreshold;
        });

        if (over.length === 0) {
          return ok(
            `✅ No keywords found with CPA > ${formatCurrency(String(Math.round(cpaThreshold * 1_000_000)))} ` +
            `(with ≥${minConversions} conversions in the period).`
          );
        }

        const lines: string[] = [
          dryRun
            ? `## 🔍 Dry Run — Keywords that WOULD be paused (CPA > ${formatCurrency(String(Math.round(cpaThreshold * 1_000_000)))})`
            : `## ⏸️ Paused Keywords (CPA > ${formatCurrency(String(Math.round(cpaThreshold * 1_000_000)))})`,
          `**Keywords affected:** ${over.length}`,
          dryRun ? "_No changes made. Set dryRun=false to actually pause._" : "",
          "",
          "| Keyword | Match | Campaign | Ad Group | Cost | Conv | CPA |",
          "|---|---|---|---|---|---|---|",
        ];

        for (const row of over) {
          const k = row.adGroupCriterion as Record<string, unknown>;
          const kw = k.keyword as Record<string, string> | undefined;
          const ag = row.adGroup as Record<string, string>;
          const c = row.campaign as Record<string, string>;
          const m = row.metrics as Record<string, string | number> | undefined;

          lines.push(
            `| ${kw?.text ?? "—"} | ${kw?.matchType ?? "—"} | ${c.name} | ${ag.name} | ` +
            `${formatCurrency(m?.costMicros)} | ${Number(m?.conversions ?? 0).toFixed(1)} | ` +
            `${formatCurrency(m?.costPerConversion)} |`
          );
        }

        if (!dryRun) {
          // Build mutate operations
          const cid = config.customerId.replace(/-/g, "");
          const operations = over.map((row) => {
            const k = row.adGroupCriterion as Record<string, unknown>;
            const ag = row.adGroup as Record<string, string>;
            const resourceName = `customers/${cid}/adGroupCriteria/${ag.id}~${k.criterionId}`;
            return { update: { resourceName, status: "PAUSED" }, updateMask: "status" };
          });

          // Batch in chunks of 100 (API limit)
          const CHUNK = 100;
          for (let i = 0; i < operations.length; i += CHUNK) {
            await gadsMutate(config, "adGroupCriteria", operations.slice(i, i + CHUNK));
          }

          lines.push("", `✅ **${over.length} keywords paused successfully.**`);
        }

        return ok(lines.join("\n"));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Add Negative Keyword ────────────────────────────────────────────────────
  server.registerTool(
    "gads_add_negative_keyword",
    {
      title: "Add Negative Keyword",
      description: `Add a negative keyword to a campaign or ad group.

Args:
  - keywordText: Keyword text (without match type brackets — use matchType instead)
  - matchType: "BROAD" | "PHRASE" | "EXACT"
  - campaignId: Campaign ID (required)
  - adGroupId: (optional) Ad group ID — if provided, adds at ad-group level; otherwise adds at campaign level

Returns: Confirmation message.

Examples:
  - "Add negative keyword 'free' broad match to campaign 123" → keywordText="free", matchType="BROAD", campaignId="123"
  - "Block exact 'cheap insurance' in ad group 456" → keywordText="cheap insurance", matchType="EXACT", campaignId="123", adGroupId="456"`,
      inputSchema: z.object({
        keywordText: z.string().min(1).describe("Negative keyword text (no brackets needed)."),
        matchType: z
          .enum(["BROAD", "PHRASE", "EXACT"])
          .describe("Match type: BROAD, PHRASE, or EXACT."),
        campaignId: z.string().describe("Campaign ID (required)."),
        adGroupId: z.string().optional().describe("Ad group ID — if provided, adds at ad-group level."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ keywordText, matchType, campaignId, adGroupId }) => {
      try {
        const config = getConfig();
        const cid = config.customerId.replace(/-/g, "");

        if (adGroupId) {
          const resourceName = `customers/${cid}/adGroups/${adGroupId}`;
          await gadsMutate(config, "adGroupCriteria", [
            {
              create: {
                adGroup: resourceName,
                type: "KEYWORD",
                negative: true,
                keyword: { text: keywordText, matchType },
              },
            },
          ]);
          return ok(
            `✅ Negative keyword "${keywordText}" [${matchType}] added to ad group ${adGroupId}.`
          );
        } else {
          const resourceName = `customers/${cid}/campaigns/${campaignId}`;
          await gadsMutate(config, "campaignCriteria", [
            {
              create: {
                campaign: resourceName,
                type: "KEYWORD",
                negative: true,
                keyword: { text: keywordText, matchType },
              },
            },
          ]);
          return ok(
            `✅ Negative keyword "${keywordText}" [${matchType}] added to campaign ${campaignId}.`
          );
        }
      } catch (e) {
        return err(String(e));
      }
    }
  );
}
