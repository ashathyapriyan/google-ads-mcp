import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  gaqlSearch,
  formatCurrency,
  formatPercent,
  microsToAmount,
  truncateIfNeeded,
} from "../services/google-ads-client.js";
import {
  DateRangeSchema,
  buildDateClause,
  LimitSchema,
} from "../schemas/common.js";
import type { GoogleAdsConfig, ToolResponse } from "../types.js";

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateIfNeeded(text) }] };
}
function err(text: string): ToolResponse {
  return { content: [{ type: "text", text: `❌ Error: ${text}` }], isError: true };
}

export function registerReportTools(
  server: McpServer,
  getConfig: () => GoogleAdsConfig
): void {

  // ── Search Term Report ──────────────────────────────────────────────────────
  server.registerTool(
    "gads_search_term_report",
    {
      title: "Search Term Report",
      description: `Pull the search term report — shows actual search queries that triggered your ads.

This is essential for finding irrelevant queries to add as negatives, or high-performing terms to add as keywords.

Args:
  - campaignId: (optional) filter to a specific campaign
  - adGroupId: (optional) filter to a specific ad group
  - dateRange: date range (default LAST_30_DAYS)
  - minClicks: only include terms with at least this many clicks (default 0)
  - sortBy: "cost" | "clicks" | "impressions" | "conversions" (default "clicks")
  - limit: max rows (default 100)

Returns: Markdown table of search terms with metrics and match status.

Examples:
  - "Show me my search term report" → default params
  - "Find search terms with clicks but no conversions" → requires post-filtering from results
  - "What queries triggered my brand campaign?" → campaignId="123"`,
      inputSchema: z.object({
        campaignId: z.string().optional().describe("Filter to a specific campaign ID."),
        adGroupId: z.string().optional().describe("Filter to a specific ad group ID."),
        dateRange: DateRangeSchema.optional(),
        minClicks: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Only show terms with at least this many clicks (default 0)."),
        sortBy: z
          .enum(["cost", "clicks", "impressions", "conversions"])
          .default("clicks")
          .describe("Sort results by this metric (default: clicks)."),
        limit: LimitSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ campaignId, adGroupId, dateRange, minClicks, sortBy, limit }) => {
      try {
        const config = getConfig();
        const dateWhere = buildDateClause(dateRange);
        const campaignWhere = campaignId ? `AND campaign.id = '${campaignId}'` : "";
        const adGroupWhere = adGroupId ? `AND ad_group.id = '${adGroupId}'` : "";
        const clicksWhere = minClicks > 0 ? `AND metrics.clicks >= ${minClicks}` : "";

        const sortFieldMap: Record<string, string> = {
          cost: "metrics.cost_micros",
          clicks: "metrics.clicks",
          impressions: "metrics.impressions",
          conversions: "metrics.conversions",
        };

        const query = `
          SELECT
            search_term_view.search_term,
            search_term_view.status,
            campaign.id,
            campaign.name,
            ad_group.id,
            ad_group.name,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.ctr,
            metrics.average_cpc,
            metrics.conversions,
            metrics.cost_per_conversion
          FROM search_term_view
          WHERE ${dateWhere} ${campaignWhere} ${adGroupWhere} ${clicksWhere}
          ORDER BY ${sortFieldMap[sortBy]} DESC
          LIMIT ${limit}
        `.trim();

        const rows = await gaqlSearch(config, query);

        if (rows.length === 0) {
          return ok("No search terms found for the given parameters.");
        }

        const lines: string[] = [
          `## Search Term Report (${rows.length} terms)`,
          "",
          "| Search Term | Status | Campaign | Ad Group | Impressions | Clicks | Cost | CTR | Avg CPC | Conv | CPA |",
          "|---|---|---|---|---|---|---|---|---|---|---|",
        ];

        for (const row of rows) {
          const st = row.searchTermView as Record<string, string>;
          const ag = row.adGroup as Record<string, string>;
          const c = row.campaign as Record<string, string>;
          const m = row.metrics as Record<string, string | number> | undefined;

          const statusEmoji =
            st.status === "ADDED" ? "✅" :
            st.status === "EXCLUDED" ? "🚫" : "💡";

          lines.push(
            `| ${st.searchTerm} | ${statusEmoji} ${st.status} | ${c.name} | ${ag.name} | ` +
            `${Number(m?.impressions ?? 0).toLocaleString()} | ${Number(m?.clicks ?? 0).toLocaleString()} | ` +
            `${formatCurrency(m?.costMicros)} | ${formatPercent(Number(m?.ctr ?? 0))} | ` +
            `${formatCurrency(m?.averageCpc)} | ${Number(m?.conversions ?? 0).toFixed(1)} | ` +
            `${formatCurrency(m?.costPerConversion)} |`
          );
        }

        lines.push(
          "",
          "_Status legend: ✅ ADDED (existing keyword) | 💡 NONE (not added yet) | 🚫 EXCLUDED (negative)_"
        );

        return ok(lines.join("\n"));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Ad Group Performance ────────────────────────────────────────────────────
  server.registerTool(
    "gads_list_ad_groups",
    {
      title: "List Ad Groups with Performance",
      description: `List ad groups with performance metrics.

Args:
  - campaignId: (optional) filter to a specific campaign
  - statusFilter: "ENABLED" | "PAUSED" | "REMOVED" | "ALL" (default: "ENABLED")
  - dateRange: date range for metrics (default LAST_30_DAYS)
  - limit: max rows (default 100)

Returns: Markdown table of ad groups with impressions, clicks, cost, CTR, CPC, conversions, CPA.`,
      inputSchema: z.object({
        campaignId: z.string().optional().describe("Filter to a specific campaign ID."),
        statusFilter: z
          .enum(["ALL", "ENABLED", "PAUSED", "REMOVED"])
          .default("ENABLED")
          .describe('Status filter (default "ENABLED").'),
        dateRange: DateRangeSchema.optional(),
        limit: LimitSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ campaignId, statusFilter, dateRange, limit }) => {
      try {
        const config = getConfig();
        const dateWhere = buildDateClause(dateRange);
        const campaignWhere = campaignId ? `AND campaign.id = '${campaignId}'` : "";
        const statusWhere = statusFilter === "ALL" ? "" : `AND ad_group.status = '${statusFilter}'`;

        const query = `
          SELECT
            ad_group.id,
            ad_group.name,
            ad_group.status,
            ad_group.cpc_bid_micros,
            campaign.id,
            campaign.name,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.ctr,
            metrics.average_cpc,
            metrics.conversions,
            metrics.cost_per_conversion
          FROM ad_group
          WHERE ${dateWhere} ${campaignWhere} ${statusWhere}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${limit}
        `.trim();

        const rows = await gaqlSearch(config, query);

        if (rows.length === 0) {
          return ok(`No ad groups found.`);
        }

        const lines: string[] = [
          `## Ad Groups (${rows.length} returned)`,
          "",
          "| ID | Ad Group | Campaign | Status | Default Bid | Impressions | Clicks | Cost | CTR | Avg CPC | Conv | CPA |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|",
        ];

        for (const row of rows) {
          const ag = row.adGroup as Record<string, string>;
          const c = row.campaign as Record<string, string>;
          const m = row.metrics as Record<string, string | number> | undefined;

          lines.push(
            `| ${ag.id} | ${ag.name} | ${c.name} | ${ag.status} | ` +
            `${formatCurrency(ag.cpcBidMicros)} | ` +
            `${Number(m?.impressions ?? 0).toLocaleString()} | ${Number(m?.clicks ?? 0).toLocaleString()} | ` +
            `${formatCurrency(m?.costMicros)} | ${formatPercent(Number(m?.ctr ?? 0))} | ` +
            `${formatCurrency(m?.averageCpc)} | ${Number(m?.conversions ?? 0).toFixed(1)} | ` +
            `${formatCurrency(m?.costPerConversion)} |`
          );
        }

        return ok(lines.join("\n"));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Account Overview ────────────────────────────────────────────────────────
  server.registerTool(
    "gads_get_account_overview",
    {
      title: "Get Account Overview",
      description: `Get a high-level overview of your Google Ads account — total spend, clicks, impressions, conversions, and key KPIs for a date range.

Args:
  - dateRange: date range (default LAST_30_DAYS)

Returns: Account-level summary with totals and KPIs.

Examples:
  - "Give me an account overview for this month" → relativeDateRange="THIS_MONTH"
  - "What's my total spend last 7 days?" → relativeDateRange="LAST_7_DAYS"`,
      inputSchema: z.object({
        dateRange: DateRangeSchema.optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dateRange }) => {
      try {
        const config = getConfig();
        const dateWhere = buildDateClause(dateRange);

        const query = `
          SELECT
            customer.id,
            customer.descriptive_name,
            customer.currency_code,
            customer.time_zone,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value,
            metrics.ctr,
            metrics.average_cpc,
            metrics.cost_per_conversion
          FROM customer
          WHERE ${dateWhere}
        `.trim();

        const rows = await gaqlSearch(config, query);

        if (rows.length === 0) {
          return ok("No account data found.");
        }

        // Aggregate across all rows (customer table returns one row per day if segmented)
        let totalImpressions = 0;
        let totalClicks = 0;
        let totalCostMicros = 0;
        let totalConversions = 0;
        let totalConvValue = 0;
        let currency = "USD";
        let accountName = "—";
        let timezone = "—";

        for (const row of rows) {
          const cust = row.customer as Record<string, string | undefined> | undefined;
          const m = row.metrics as Record<string, string | number> | undefined;

          if (cust?.descriptiveName) accountName = cust.descriptiveName;
          if (cust?.currencyCode) currency = cust.currencyCode;
          if (cust?.timeZone) timezone = cust.timeZone;

          totalImpressions += Number(m?.impressions ?? 0);
          totalClicks += Number(m?.clicks ?? 0);
          totalCostMicros += Number(m?.costMicros ?? 0);
          totalConversions += Number(m?.conversions ?? 0);
          totalConvValue += Number(m?.conversionsValue ?? 0);
        }

        const totalCost = microsToAmount(String(totalCostMicros));
        const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
        const avgCpc = totalClicks > 0 ? totalCost / totalClicks : 0;
        const cpa = totalConversions > 0 ? totalCost / totalConversions : 0;
        const roas = totalCost > 0 ? totalConvValue / totalCost : 0;

        const dateLabel = dateRange?.relativeDateRange ?? dateRange?.startDate ?? "LAST_30_DAYS";

        const lines = [
          `## 📊 Account Overview — ${accountName}`,
          `**Period:** ${dateLabel} | **Currency:** ${currency} | **Timezone:** ${timezone}`,
          "",
          "| Metric | Value |",
          "|---|---|",
          `| Impressions | ${totalImpressions.toLocaleString()} |`,
          `| Clicks | ${totalClicks.toLocaleString()} |`,
          `| CTR | ${formatPercent(ctr)} |`,
          `| Total Cost | ${formatCurrency(String(totalCostMicros), currency)} |`,
          `| Avg CPC | ${new Intl.NumberFormat("en-US", { style: "currency", currency }).format(avgCpc)} |`,
          `| Conversions | ${totalConversions.toFixed(1)} |`,
          `| CPA | ${new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cpa)} |`,
          `| Conv. Value | ${new Intl.NumberFormat("en-US", { style: "currency", currency }).format(totalConvValue)} |`,
          `| ROAS | ${roas.toFixed(2)}x |`,
        ];

        return ok(lines.join("\n"));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Day-by-Day Trend ────────────────────────────────────────────────────────
  server.registerTool(
    "gads_daily_performance_trend",
    {
      title: "Daily Performance Trend",
      description: `Get day-by-day performance metrics to identify trends, traffic drops, or spend spikes.

Args:
  - campaignId: (optional) filter to a specific campaign
  - dateRange: date range (default LAST_14_DAYS)
  - limit: max days to return (default 90)

Returns: Chronological table of daily performance data.

Examples:
  - "Show me my daily spend trend this month" → relativeDateRange="THIS_MONTH"
  - "Did traffic drop on any days last week?" → relativeDateRange="LAST_7_DAYS"`,
      inputSchema: z.object({
        campaignId: z.string().optional().describe("Filter to a specific campaign ID."),
        dateRange: DateRangeSchema.optional(),
        limit: z.number().int().min(1).max(365).default(30).describe("Max number of days (default 30)."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ campaignId, dateRange, limit }) => {
      try {
        const config = getConfig();
        const dateWhere = buildDateClause(dateRange ?? { relativeDateRange: "LAST_14_DAYS" });
        const campaignWhere = campaignId ? `AND campaign.id = '${campaignId}'` : "";

        const query = `
          SELECT
            segments.date,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.ctr,
            metrics.conversions,
            metrics.cost_per_conversion
          FROM ${campaignId ? "campaign" : "customer"}
          WHERE ${dateWhere} ${campaignWhere}
          ORDER BY segments.date ASC
          LIMIT ${limit}
        `.trim();

        const rows = await gaqlSearch(config, query);

        if (rows.length === 0) {
          return ok("No daily data found for the given parameters.");
        }

        const lines: string[] = [
          `## Daily Performance Trend (${rows.length} days)`,
          "",
          "| Date | Impressions | Clicks | Cost | CTR | Conv | CPA |",
          "|---|---|---|---|---|---|---|",
        ];

        for (const row of rows) {
          const seg = row.segments as Record<string, string> | undefined;
          const m = row.metrics as Record<string, string | number> | undefined;

          lines.push(
            `| ${seg?.date ?? "—"} | ${Number(m?.impressions ?? 0).toLocaleString()} | ` +
            `${Number(m?.clicks ?? 0).toLocaleString()} | ${formatCurrency(m?.costMicros)} | ` +
            `${formatPercent(Number(m?.ctr ?? 0))} | ${Number(m?.conversions ?? 0).toFixed(1)} | ` +
            `${formatCurrency(m?.costPerConversion)} |`
          );
        }

        return ok(lines.join("\n"));
      } catch (e) {
        return err(String(e));
      }
    }
  );
}
