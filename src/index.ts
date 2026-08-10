#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 400:
        message = `The ${actorLabel} run was rejected as invalid input.${detail}`;
        break;
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message =
          "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Ask for less per call, or run the actor on Apify directly for larger jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  // A 2xx from run-sync-get-dataset-items normally carries the dataset array.
  // Anything else on this path is a failure the caller must see, never an empty
  // success: surfacing it here is what keeps a failed run from reading as "no
  // results found".
  let items: unknown;
  try {
    items = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-people-finder",
  version: pkg.version,
});

// People Finder & Email Verifier (immutable actor ID LEgloG7tWgQl4o6TD)
server.registerTool(
  "find_people_and_emails",
  {
    title: "Find People and Emails",
    description:
      "Find people at a company and optionally discover and verify their business email. Identify the company by bare domain, by company name, by LinkedIn company URL, or pass a list of domains to run a batch where every output row echoes its source domain. Results are filtered by job title include and exclude lists, by normalized seniority, by normalized department and by country. A four layer cascade runs the company website, public search and a licensed database fallback, with company match scoring on every candidate; nothing here scrapes LinkedIn directly. Email discovery runs a two provider waterfall and verification escalates catch all domains to a second provider for a definitive answer. Provider keys are yours: you supply them, the vendors bill you directly, and the actor does not mark them up. Without a Serper key the search layer is off and coverage drops sharply. targetCount is a hard cost cap because billing is per person actually returned. Requires an APIFY_TOKEN and consumes Apify credits. Read only: it finds and verifies, it writes nothing.",
    annotations: {
      title: "Find People and Emails",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    domain: z.string().optional().describe("Bare domain without https:// or trailing slash. Example: stripe.com"),
    company_name: z.string().optional().describe("Used when no domain is available, or as a disambiguation hint alongside a domain."),
    linkedin_company_url: z.string().optional().describe("Example: https://www.linkedin.com/company/stripe. Skips internal company resolution when provided."),
    domains: z.array(z.string()).optional().describe("Optional list of bare domains. Takes precedence over the single domain field. Each domain is searched independently and every output row echoes its source domain."),
    targetCount: z.number().int().optional().describe("Maximum people to return per company. Billing is per person actually returned, so a lower number is a hard cost cap. Default: 5."),
    jobTitles: z.array(z.string()).optional().describe("Case-insensitive substring match against the person's current title. Any match qualifies. Leave empty for no title filter. Example: VP Sales, Head of Growth"),
    excludeJobTitles: z.array(z.string()).optional().describe("Case-insensitive substring match. A person matching any of these is dropped even if they matched an include. Example: intern, assistant, former"),
    seniority: z.array(z.enum(["founder", "c_suite", "vp", "director", "head", "manager", "senior", "individual_contributor", "entry"])).optional().describe("Filter to these normalized seniority levels. Leave empty for all."),
    departments: z.array(z.enum(["executive", "sales", "marketing", "revops", "customer_success", "product", "engineering", "design", "finance", "hr", "legal", "it", "operations", "other"])).optional().describe("Filter to these normalized departments. Leave empty for all."),
    countries: z.array(z.string()).optional().describe("ISO 3166-1 alpha-2 codes. Filters to people located in these countries. Example: US, GB, NL"),
    includeEmails: z.boolean().optional().describe("Discover a business email for each person found, using your Icypeas and/or Prospeo keys. Billed only when an email is actually returned. Turn off to build an org map cheaply. Default: true."),
    verifyEmails: z.boolean().optional().describe("Check deliverability of each email found, escalating catch-all domains to a second provider for a definitive answer. Requires a Reoon and/or BounceBan key. Default: true."),
    verifyPosition: z.boolean().optional().describe("Check that the person still holds the returned title at the target company, and report the reasoning. Reduces bounced outreach to people who have moved on. Default: false."),
    suppressLinkedInUrls: z.array(z.string()).optional().describe("LinkedIn profile URLs to exclude from results. Use to suppress already-contacted prospects or honor data subject removal requests."),
    batchSize: z.number().int().optional().describe("How many companies to search concurrently in batch mode. Default 5, maximum 10. Default: 5."),
    skipCache: z.boolean().optional().describe("Results are cached for 7 days and reused on repeat lookups. Set true to force a fresh search. Default: false."),
    serpApiKey: z.string().optional().describe("Serper.dev API key. Unlocks the search layer, which is the highest-coverage source of LinkedIn profile URLs. Without it this actor falls back to company website parsing only, which returns far fewer people. Get a key at https://serper.dev. You are billed by Serper for searches; this actor does not mark them up."),
    prospeoApiKey: z.string().optional().describe("Second provider in the email waterfall. Used only for people the first provider could not resolve. Get a key at https://prospeo.io. Billed to you by Prospeo; this actor does not mark it up."),
    reoonApiKey: z.string().optional().describe("Primary email verification. Returns deliverability status for each discovered address. Get a key at https://emailverifier.reoon.com. Billed to you by Reoon."),
    bounceBanApiKey: z.string().optional().describe("Catch-all resolution. Used only when the primary verifier returns catch-all or risky, to determine whether that specific mailbox exists. Get a key at https://bounceban.com. Billed to you by BounceBan."),
    icypeasApiKey: z.string().optional().describe("Optional. Only used for the licensed-database fallback layer, which runs when the company website and public search results do not yield enough people. Leave empty to skip that layer entirely; the run still succeeds and reports any shortfall in the summary."),
    claudeApiKey: z.string().optional().describe("Optional. Only used to classify job titles that the built-in rule table cannot place into a seniority and department. One batched call per run, never per person. Leave empty to leave those two fields null on the affected rows."),
    },
  },
  async (args) =>
    runActor("LEgloG7tWgQl4o6TD", "People Finder & Email Verifier", compact(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
