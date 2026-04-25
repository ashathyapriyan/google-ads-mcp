# Google Ads MCP Server

A production-ready [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude directly to your Google Ads account. Pull reports, manage campaigns, pause keywords by CPA, create ads — all via natural language.

---

## Tools Available

| Tool | Description |
|---|---|
| `gads_list_campaigns` | List all campaigns with status & metrics |
| `gads_get_campaign_performance` | Detailed performance report by date range |
| `gads_update_campaign_status` | Pause / enable / remove a campaign |
| `gads_update_campaign_budget` | Change a campaign's daily budget |
| `gads_list_ad_groups` | List ad groups with performance |
| `gads_list_keywords` | List keywords with QS, bids & metrics |
| `gads_update_keyword_status` | Pause / enable / remove a keyword |
| `gads_update_keyword_bid` | Change a keyword's max CPC bid |
| `gads_bulk_pause_keywords_by_cpa` | Auto-pause all keywords over a CPA threshold |
| `gads_add_negative_keyword` | Add a negative keyword to campaign or ad group |
| `gads_list_ads` | List ads with headlines, descriptions & metrics |
| `gads_create_responsive_search_ad` | Create a new Responsive Search Ad |
| `gads_update_ad_status` | Pause / enable / remove an ad |
| `gads_search_term_report` | See actual search queries triggering your ads |
| `gads_get_account_overview` | Account-level KPI summary |
| `gads_daily_performance_trend` | Day-by-day performance table |

---

## Prerequisites

1. **Google Ads API Developer Token** — Apply at [developers.google.com/google-ads/api](https://developers.google.com/google-ads/api/docs/get-started/dev-token). Takes ~24 hours to approve.

2. **Google Cloud Project** with the Google Ads API enabled.

3. **OAuth2 Credentials** (Desktop App type) from Google Cloud Console.

4. **Node.js 18+**

---

## Setup

### Step 1 — Clone & Install

```bash
git clone <your-repo-url>
cd google-ads-mcp-server
npm install
```

### Step 2 — Create OAuth2 Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. Enable the **Google Ads API**
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Choose **Desktop App**, give it a name, download the JSON

### Step 3 — Generate a Refresh Token

Run this one-time script to get your refresh token:

```bash
# Install the Google auth library temporarily
npx --yes google-auth-library-nodejs-oauth2-cli \
  --client_id YOUR_CLIENT_ID \
  --client_secret YOUR_CLIENT_SECRET \
  --scope https://www.googleapis.com/auth/adwords
```

Or use the [OAuth2 Playground](https://developers.google.com/oauthplayground):
1. Go to OAuth 2.0 Playground
2. Click ⚙️ Settings → check "Use your own OAuth credentials"
3. Enter your Client ID and Secret
4. In Step 1, select `https://www.googleapis.com/auth/adwords`
5. Authorize → Exchange code for tokens
6. Copy the **Refresh token**

### Step 4 — Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

```env
GADS_CLIENT_ID=your-client-id.apps.googleusercontent.com
GADS_CLIENT_SECRET=your-client-secret
GADS_REFRESH_TOKEN=your-refresh-token
GADS_DEVELOPER_TOKEN=your-developer-token
GADS_CUSTOMER_ID=1234567890   # 10 digits, no hyphens
```

**If using a Manager (MCC) account**, also add:
```env
GADS_LOGIN_CUSTOMER_ID=your-mcc-account-id
```

### Step 5 — Build

```bash
npm run build
```

### Step 6 — Connect to Claude

Add this to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "google-ads": {
      "command": "node",
      "args": ["/absolute/path/to/google-ads-mcp-server/dist/index.js"],
      "env": {
        "GADS_CLIENT_ID": "your-client-id",
        "GADS_CLIENT_SECRET": "your-client-secret",
        "GADS_REFRESH_TOKEN": "your-refresh-token",
        "GADS_DEVELOPER_TOKEN": "your-developer-token",
        "GADS_CUSTOMER_ID": "1234567890"
      }
    }
  }
}
```

Restart Claude Desktop. You should see 🔌 Google Ads tools available.

---

## Example Prompts

```
Pull my last 7 days campaign performance
```
```
Show me my search term report for this month
```
```
Pause all keywords with CPA over $50 in the last 30 days
```
```
What's my total account spend this month?
```
```
Create a new ad in ad group 456789 with these headlines: [Buy Now, Limited Offer, Shop Today] 
and descriptions: [Save up to 50% on orders, Free shipping on all orders over $30]
URL: https://example.com/sale
```
```
Show me the daily spend trend for campaign 123456 this month
```
```
List all paused campaigns
```
```
Add 'free' as a broad match negative keyword to campaign 123
```

---

## API Version

This server uses Google Ads API **v18**. To upgrade, change `GADS_API_VERSION` in `src/constants.ts` and rebuild.

Check the current version at [developers.google.com/google-ads/api/docs/release-notes](https://developers.google.com/google-ads/api/docs/release-notes).

---

## Security Notes

- Never commit `.env` to version control — it's in `.gitignore`
- Your refresh token grants full Google Ads access — treat it like a password
- The `REMOVED` status on campaigns/keywords is **permanent** — use `PAUSED` unless you're sure
- `gads_bulk_pause_keywords_by_cpa` defaults to `dryRun=true` for safety

---

## Development

```bash
npm run dev          # Run with tsx watch (auto-reload)
npm run build        # Compile TypeScript
npm run inspector    # Launch MCP Inspector UI for testing
```

## Troubleshooting

| Error | Fix |
|---|---|
| `UNAUTHENTICATED` | Check your refresh token — it may have expired or been revoked |
| `PERMISSION_DENIED` | Your developer token may not be approved yet (can take 24h) |
| `CUSTOMER_NOT_FOUND` | Verify your GADS_CUSTOMER_ID (10 digits, no hyphens) |
| `REQUEST_ERROR: missing header` | Ensure `developer-token` header is set — check your env vars |
| `login-customer-id required` | Add `GADS_LOGIN_CUSTOMER_ID` if accessing via a Manager account |
