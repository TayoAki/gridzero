// Connected apps behind our own interface (agent spec §10.1). Composio is one
// implementation; FakeAppProvider is for tests (APP_PROVIDER=fake). See README.md here.

import { Composio } from "@composio/core";

export interface AppAction {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: object;
}

export interface AppProvider {
  catalog(): CatalogApp[];
  connectUrl(userId: string, slug: string, returnUrl: string): Promise<string>;
  connections(userId: string): Promise<{ slug: string; status: "active" | "pending" | "error" }[]>;
  disconnect(userId: string, slug: string): Promise<void>;
  findActions(userId: string, slug: string, query: string): Promise<AppAction[]>;
  runAction(userId: string, name: string, args: object): Promise<unknown>;
}

export interface CatalogApp {
  slug: string;
  name: string;
  category: string;
}

export const CATALOG: CatalogApp[] = [
  { slug: "gmail", name: "Gmail", category: "Email" },
  { slug: "googlecalendar", name: "Google Calendar", category: "Calendar" },
  { slug: "googledrive", name: "Google Drive", category: "Files" },
  { slug: "slack", name: "Slack", category: "Chat" },
  { slug: "notion", name: "Notion", category: "Docs" },
  { slug: "github", name: "GitHub", category: "Code" },
  { slug: "hubspot", name: "HubSpot", category: "CRM" },
  { slug: "salesforce", name: "Salesforce", category: "CRM" },
  { slug: "jira", name: "Jira", category: "Projects" },
  { slug: "linear", name: "Linear", category: "Projects" },
];

const READ = /(_|^)(GET|LIST|SEARCH|FETCH|FIND|READ)(_|$)/i;
const WRITE = /(SEND|CREATE|UPDATE|DELETE|POST|REMOVE|ARCHIVE|MOVE)/i;

/** Whether an action only reads (spec §10.1). Anything unclear counts as a change. */
export const isReadOnly = (name: string) => READ.test(name) && !WRITE.test(name);

export const appName = (slug: string) => CATALOG.find((a) => a.slug === slug)?.name ?? slug;

// --- Composio ----------------------------------------------------------------

const STATUS: Record<string, "active" | "pending" | "error"> = {
  ACTIVE: "active",
  INITIALIZING: "pending",
  INITIATED: "pending",
};

export class ComposioProvider implements AppProvider {
  private client: Composio;

  constructor(apiKey: string) {
    this.client = new Composio({ apiKey, allowTracking: false });
  }

  catalog() {
    return CATALOG;
  }

  async connectUrl(userId: string, slug: string, _returnUrl: string): Promise<string> {
    // Composio-managed auth: makes the auth config on first use, then a link for this user.
    const request = await this.client.toolkits.authorize(userId, slug);
    if (!request.redirectUrl) throw new Error(`${appName(slug)} did not return a sign-in link.`);
    return request.redirectUrl;
  }

  async connections(userId: string) {
    const res = await this.client.connectedAccounts.list({ userIds: [userId] });
    const best = new Map<string, "active" | "pending" | "error">();
    for (const a of res.items) {
      const status = STATUS[a.status] ?? "error";
      const prev = best.get(a.toolkit.slug);
      if (!prev || status === "active" || (status === "pending" && prev === "error")) best.set(a.toolkit.slug, status);
    }
    return [...best].map(([slug, status]) => ({ slug, status }));
  }

  async disconnect(userId: string, slug: string) {
    const res = await this.client.connectedAccounts.list({ userIds: [userId], toolkitSlugs: [slug] });
    for (const a of res.items) await this.client.connectedAccounts.delete(a.id);
  }

  async findActions(_userId: string, slug: string, query: string): Promise<AppAction[]> {
    const tools = await this.client.tools.getRawComposioTools({ toolkits: [slug], search: query || undefined, limit: 10 });
    return tools.slice(0, 10).map((t) => ({ name: t.slug, description: (t.description ?? t.name).slice(0, 500), readOnly: isReadOnly(t.slug), inputSchema: t.inputParameters ?? {} }));
  }

  async runAction(userId: string, name: string, args: object): Promise<unknown> {
    // Pin the tool's current version, as the SDK asks for manual execution.
    const tool = await this.client.tools.getRawComposioToolBySlug(name);
    const res = await this.client.tools.execute(name, { userId, version: tool.version, arguments: args as Record<string, unknown> });
    if (!res.successful) throw new Error(res.error ?? "The action failed.");
    return res.data;
  }
}

// --- fake (tests) ------------------------------------------------------------

/** In-memory provider: gmail is connected; it has one read and one write action. */
export class FakeAppProvider implements AppProvider {
  readonly calls: { userId: string; name: string; args: object }[] = [];
  private connected = new Map<string, Set<string>>();

  catalog() {
    return CATALOG;
  }

  async connectUrl(userId: string, slug: string, returnUrl: string) {
    // Connecting completes at once, so tests can follow the flow.
    if (!this.connected.has(userId)) this.connected.set(userId, new Set());
    this.connected.get(userId)!.add(slug);
    return `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}connected=${slug}`;
  }

  async connections(userId: string) {
    return [...(this.connected.get(userId) ?? [])].map((slug) => ({ slug, status: "active" as const }));
  }

  async disconnect(userId: string, slug: string) {
    this.connected.get(userId)?.delete(slug);
  }

  async findActions(_userId: string, slug: string, _query: string): Promise<AppAction[]> {
    const up = slug.toUpperCase();
    return [
      { name: `${up}_FETCH_EMAILS`, description: "Fetch recent emails.", readOnly: true, inputSchema: { type: "object", properties: { max: { type: "integer" } } } },
      { name: `${up}_SEND_EMAIL`, description: "Send an email.", readOnly: false, inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } } } },
    ];
  }

  async runAction(userId: string, name: string, args: object) {
    this.calls.push({ userId, name, args });
    if (isReadOnly(name)) return { emails: [{ from: "ceo@example.com", subject: "Numbers?" }] };
    return { sent: true, id: `msg_${this.calls.length}` };
  }
}

let provider: AppProvider | null | undefined;

/** The configured provider, or null when connected apps are not set up. */
export function appProvider(): AppProvider | null {
  if (provider !== undefined) return provider;
  if (process.env.APP_PROVIDER === "fake") provider = new FakeAppProvider();
  else if (process.env.COMPOSIO_API_KEY) provider = new ComposioProvider(process.env.COMPOSIO_API_KEY);
  else provider = null;
  return provider;
}
