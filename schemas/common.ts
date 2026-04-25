import { z } from "zod";

// ─── Date range ───────────────────────────────────────────────────────────────
// Accepts "YYYY-MM-DD" or Google Ads relative dates like "LAST_7_DAYS"

const RELATIVE_DATES = [
  "TODAY",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "THIS_MONTH",
  "LAST_MONTH",
  "THIS_QUARTER",
  "LAST_QUARTER",
  "THIS_YEAR",
  "LAST_YEAR",
] as const;

export const DateRangeSchema = z
  .object({
    startDate: z
      .string()
      .describe(
        'Start date as YYYY-MM-DD (e.g. "2024-01-01") or a relative date like "LAST_7_DAYS". ' +
          `Relative options: ${RELATIVE_DATES.join(", ")}`
      )
      .optional(),
    endDate: z
      .string()
      .describe('End date as YYYY-MM-DD (e.g. "2024-12-31"). Not needed for relative dates.')
      .optional(),
    relativeDateRange: z
      .enum(RELATIVE_DATES)
      .describe("Google Ads relative date range — use this instead of startDate/endDate for convenience.")
      .optional(),
  })
  .describe("Date range for metrics. Use relativeDateRange for convenience or startDate+endDate for custom ranges.");

export type DateRange = z.infer<typeof DateRangeSchema>;

// Build GAQL WHERE clause segment for date range
export function buildDateClause(range: DateRange | undefined): string {
  if (!range) return "segments.date DURING LAST_30_DAYS";

  if (range.relativeDateRange) {
    return `segments.date DURING ${range.relativeDateRange}`;
  }
  if (range.startDate && range.endDate) {
    return `segments.date BETWEEN '${range.startDate}' AND '${range.endDate}'`;
  }
  if (range.startDate) {
    return `segments.date >= '${range.startDate}'`;
  }
  return "segments.date DURING LAST_30_DAYS";
}

// ─── Status filter ────────────────────────────────────────────────────────────

export const StatusFilterSchema = z
  .enum(["ALL", "ENABLED", "PAUSED", "REMOVED"])
  .default("ENABLED")
  .describe('Filter by status. Default is "ENABLED" (active items only). Use "ALL" to include paused/removed.');

export const UpdateStatusSchema = z
  .enum(["ENABLED", "PAUSED", "REMOVED"])
  .describe('New status. Use "PAUSED" to pause, "ENABLED" to re-enable, "REMOVED" to permanently delete.');

// ─── Pagination ───────────────────────────────────────────────────────────────

export const LimitSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .default(100)
  .describe("Maximum number of rows to return (1–1000, default 100).");

// ─── IDs ──────────────────────────────────────────────────────────────────────

export const CampaignIdSchema = z
  .string()
  .describe('Campaign ID (numeric string, e.g. "1234567890"). Leave blank to query across all campaigns.');

export const AdGroupIdSchema = z
  .string()
  .describe('Ad group ID (numeric string). Leave blank to query across all ad groups.');
