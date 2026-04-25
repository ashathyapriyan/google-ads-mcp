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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateIfNeeded(text) }] };
}
function err(text: string): ToolResponse {
  return { content: [{ type: "text", text: `❌ Error: ${text}` }], isError: true };
}

// ─── Register Tools ───────────────────────────────────────────────────────────

export function registerCampaignTools(
  server: McpServer,
  getConfig: () => GoogleAdsConfig
): void {

  // ── List Campaigns ──────────────────────────────────────────────────────────
  server.registerTool(
    "gads_list_campaigns",
    {
      title: "List Google Ads Campaigns",
      description: `List campaigns in your Google Ads account with key performance metrics.

Returns campaign name, ID, status, channel type, bidding strategy, daily budget and metrics (impressions, clicks, cost, conversions, CTR, avg CPC, CPA).

Args:
  - statusFilter: "ENABLED" | "PAUSED" | "REMOVED" | "ALL" (default: "ENABLED")
  - dateRange: optional date range for metrics. Defaults to LAST_30_DAYS.
  - limit: max rows (default 100)

Returns: Markdown table of campaigns with metrics.

Examples:
  - "List my active campaigns" → statusFilter="ENABLED"
  - "Show all campaigns including paused" → statusFilter="ALL"
  - "What campaigns ran last month?" → statusFilter="ALL", relativeDateRange="LAST_MONTH"`,
      inputSchema: z.object({
        statusFilter: StatusFilterSchema,
        dateRange: DateRangeSchema.optional(),
        limit: LimitSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ statusFilter, dateRange, limit }) => {
      try {
        const config = getConfig();
        const dateWhere = buildDateClause(dateRange);
        const statusWhere =
          statusFilter === "ALL"
            ? ""
            : `AND campaign.status = '${statusFilter}'`;

        const query = `
          SELECT
            campaign.id,
            campaign.name,
            campaign.status,
            campaign.advertising_channel_type,
            campaign.bidding_strategy_type,
            campaign_budget.amount_micros,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions,
            metrics.ctr,
            metrics.average_cpc,
            metrics.cost_per_conversion
          FROM campaign
          WHERE ${dateWhere} ${statusWhere}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${limit}
        `.trim();

        const rows = await gaqlSearch(config, query);

        if (rows.length === 0) {
          return ok(`No campaigns found with status: ${statusFilter}`);
        }

        const lines: string[] = [
          `## Campaigns (${rows.length} returned, status: ${statusFilter})`,
          "",
          "| ID | Campaign | Status | Channel | Budget/day | Impressions | Clicks | Cost | CTR | Avg CPC | Conv | CPA |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|",
        ];

        for (const row of rows) {
          const c = row.campaign as Record<string, string>;
          const b = row.campaignBudget as Record<string, string> | undefined;
          const m = row.metrics as Record<string, string | number> | undefined;

          lines.push(
            `| ${c.id} | ${c.name} | ${c.status} | ${c.advertisingChannelType ?? "-"} | ` +
            `${b ? formatCurrency(b.amountMicros) : "-"} | ` +
            `${m?.impressions ?? 0} | ${m?.clicks ?? 0} | ` +
            `${formatCurrency(m?.costMicros)} | ` +
            `${formatPercent(Number(m?.ctr ?? 0))} | ` +
            `${formatCurrency(m?.averageCpc)} | ` +
            `${Number(m?.conversions ?? 0).toFixed(1)} | ` +
            `${formatCurrency(m?.costPerConversion)} |`
          );
        }

        return ok(lines.join("\n"));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Get Campaign Performance ────────────────────────────────────────────────
  server.registerTool(
    "gads_get_campaign_performance",
    {
      title: "Get Campaign Performance Report",
      description: `Fetch detailed performance metrics for one or all campaigns over a date range.

Includes impressions, clicks, cost, conversions, conversion value, CTR, CPC, ROAS, and CPA.

Args:
  - campaignId: (optional) filter to a single campaign ID. If omitted, returns all campaigns.
  - dateRange: date range for metrics (default LAST_7_DAYS)
  - limit: max rows (default 100)

Returns: Detailed performance report in Markdown.

Examples:
  - "Pull my last 7 days performance" → relativeDateRange="LAST_7_DAYS"
  - "Show campaign 123456 performance this month" → campaignId="123456", relativeDateRange="THIS_MONTH"`,
      inputSchema: z.object({
        campaignId: z.string().optional().describe("Campaign ID to filter (optional). Omit for all campaigns."),
        dateRange: DateRangeSchema.optional(),
        limit: LimitSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ campaignId, dateRange, limit }) => {
      try {
        const config = getConfig();
        const dateWhere = buildDateClause(dateRange ?? { relativeDateRange: "LAST_7_DAYS" });
        const campaignWhere = campaignId
          ? `AND campaign.id = '${campaignId}'`
          : "";

        const query = `
          SELECT
            campaign.id,
            campaign.name,
            campaign.status,
            campaign.bidding_strategy_type,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value,
            metrics.ctr,
            metrics.average_cpc,
            metrics.cost_per_conversion,
            metrics.value_per_conversion,
            metrics.search_impression_share,
            metrics.search_top_impression_share
          FROM campaign
          WHERE ${dateWhere} ${campaignWhere}
            AND campaign.status != 'REMOVED'
          ORDER BY metrics.cost_micros DESC
          LIMIT ${limit}
        `.trim();

        const rows = await gaqlSearch(config, query);

        if (rows.length === 0) {
          return ok("No campaign performance data found for the given parameters.");
        }

        const lines: string[] = [
          `## Campaign Performance Report`,
          `**Date range:** ${(dateRange?.relativeDateRange ?? dateRange?.startDate) ?? "LAST_7_DAYS"}`,
          `**Campaigns:** ${rows.length}`,
          "",
        ];

        for (const row of rows) {
          const c = row.campaign as Record<string, string>;
          const m = row.metrics as Record<string, string | number> | undefined;

          const cost = microsToAmount(String(m?.costMicros ?? 0));
          const conv = Number(m?.conversions ?? 0);
          const convValue = Number(m?.conversionsValue ?? 0);
          const roas = cost > 0 ? (convValue / cost).toFixed(2) : "—";

          lines.push(
            `### ${c.name} (ID: ${c.id})`,
            `- **Status:** ${c.status} | **Bidding:** ${c.biddingStrategyType ?? "—"}`,
            `- **Impressions:** ${Number(m?.impressions ?? 0).toLocaleString()}`,
            `- **Clicks:** ${Number(m?.clicks ?? 0).toLocaleString()} | **CTR:** ${formatPercent(Number(m?.ctr ?? 0))}`,
            `- **Cost:** ${formatCurrency(m?.costMicros)} | **Avg CPC:** ${formatCurrency(m?.averageCpc)}`,
            `- **Conversions:** ${conv.toFixed(1)} | **CPA:** ${formatCurrency(m?.costPerConversion)}`,
            `- **Conv. Value:** ${formatCurrency(String(Math.round(convValue * 1_000_000)))} | **ROAS:** ${roas}`,
            `- **Search Imp. Share:** ${formatPercent(Number(m?.searchImpressionShare ?? 0))} | **Top IS:** ${formatPercent(Number(m?.searchTopImpressionShare ?? 0))}`,
            ""
          );
        }

        return ok(lines.join("\n"));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Update Campaign Status ──────────────────────────────────────────────────
  server.registerTool(
    "gads_update_campaign_status",
    {
      title: "Update Campaign Status",
      description: `Pause, enable, or remove a Google Ads campaign.

Args:
  - campaignId: (required) Campaign ID to update
  - status: "ENABLED" | "PAUSED" | "REMOVED"

Returns: Confirmation message with resource name.

⚠️  "REMOVED" is permanent and cannot be undone.

Examples:
  - "Pause campaign 123456" → campaignId="123456", status="PAUSED"
  - "Re-enable campaign 123456" → campaignId="123456", status="ENABLED"`,
      inputSchema: z.object({
        campaignId: z.string().describe("Campaign ID to update (required)."),
        status: UpdateStatusSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ campaignId, status }) => {
      try {
        const config = getConfig();
        const resourceName = buildResourceName(config.customerId, "campaigns", campaignId);

        const result = await gadsMutate(config, "campaigns", [
          {
            update: { resourceName, status },
            updateMask: "status",
          },
        ]);

        return ok(
          `✅ Campaign ${campaignId} status updated to **${status}**.\n` +
          `Resource: ${result.results[0]?.resourceName ?? resourceName}`
        );
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ── Update Campaign Budget ──────────────────────────────────────────────────
  server.registerTool(
    "gads_update_campaign_budget",
    {
      title: "Update Campaign Daily Budget",
      description: `Change the daily budget of a campaign.

Args:
  - campaignId: Campaign ID
  - budgetAmountDaily: New daily budget in the account currency (e.g. 50 for $50/day)

Note: This updates the campaign's shared budget if one exists, or the campaign's own budget.
The actual spend can go up to 2× the daily budget on high-traffic days (Google's behaviour).

Returns: Confirmation with new budget amount.`,
      inputSchema: z.object({
        campaignId: z.string().describe("Campaign ID to update."),
        budgetAmountDaily: z
          .number()
          .positive()
          .describe("New daily budget in account currency (e.g. 50 for $50/day)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ campaignId, budgetAmountDaily }) => {
      try {
        const config = getConfig();
        const cid = config.customerId.replace(/-/g, "");

        // First, find the budget resource name
        const rows = await gaqlSearch(config, `
          SELECT campaign.id, campaign_budget.resource_name, campaign_budget.amount_micros
          FROM campaign
          WHERE campaign.id = '${campaignId}'
          LIMIT 1
        `);

        if (rows.length === 0) {
          return err(`Campaign ${campaignId} not found.`);
        }

        const budgetResource = (rows[0].campaignBudget as Record<string, string> | undefined)?.resourceName;
        if (!budgetResource) {
          return err(`Campaign ${campaignId} has no associated budget resource.`);
        }

        const amountMicros = String(Math.round(budgetAmountDaily * 1_000_000));

        await gadsMutate(config, "campaignBudgets", [
          {
            update: { resourceName: budgetResource, amountMicros },
            updateMask: "amount_micros",
          },
        ]);

        return ok(
          `✅ Campaign ${campaignId} daily budget updated to **${formatCurrency(amountMicros)}**.\n` +
          `Budget resource: ${budgetResource}`
        );
      } catch (e) {
        return err(String(e));
      }
    }
  );
}
