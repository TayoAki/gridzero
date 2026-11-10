# Connected apps

Agents reach outside apps through our `AppProvider` interface (`provider.ts`). Composio is the
only real implementation; `FakeAppProvider` stands in for it in tests (`APP_PROVIDER=fake`).
With neither `APP_PROVIDER=fake` nor `COMPOSIO_API_KEY` set, connected apps are off and the
tools answer "Connected apps are not set up on this server."

## Composio calls (`@composio/core` 0.27.0, pinned)

These come from the SDK reference shipped inside the package
(`node_modules/@composio/core/dist/docs/reference/sdk-reference/typescript/`) and were
typechecked against its types. They have not been run against a live Composio project yet.

| Our method | Composio call |
|---|---|
| client | `new Composio({ apiKey, allowTracking: false })` |
| `connectUrl(userId, slug)` | `composio.toolkits.authorize(userId, slug)` → `ConnectionRequest.redirectUrl`. Uses Composio-managed auth: it creates the toolkit's auth config on first use. |
| `connections(userId)` | `composio.connectedAccounts.list({ userIds: [userId] })` → `items[].toolkit.slug`, `items[].status` (`ACTIVE` → active; `INITIALIZING`/`INITIATED` → pending; anything else → error). |
| `disconnect(userId, slug)` | `connectedAccounts.list({ userIds: [userId], toolkitSlugs: [slug] })`, then `connectedAccounts.delete(item.id)` for each. |
| `findActions(userId, slug, query)` | `composio.tools.getRawComposioTools({ toolkits: [slug], search: query, limit: 10 })` → `slug`, `description`, `inputParameters`. |
| `runAction(userId, name, args)` | `composio.tools.getRawComposioToolBySlug(name)` for its `version`, then `composio.tools.execute(name, { userId, version, arguments: args })` → `{ successful, data, error }`. Manual execution needs a pinned version, so we pin the tool's current one. |

We use Composio's direct tool calls, not its sessions: a session gives the agent Composio's own
meta tools, which would run actions without our approval step.

## Rules

- An action counts as read-only when its name matches
  `/(_|^)(GET|LIST|SEARCH|FETCH|FIND|READ)(_|$)/i` and not
  `/(SEND|CREATE|UPDATE|DELETE|POST|REMOVE|ARCHIVE|MOVE)/i`. Anything unclear needs approval.
- `run_app_action` takes `args_json` (a JSON object as a string), because strict tool schemas
  cannot describe every app's arguments.
- Approvals run the stored arguments exactly once (`UPDATE … WHERE status = 'pending'`).
- Scheduled and widget-refresh runs never get `run_app_action`.

## Turning it on

Set `COMPOSIO_API_KEY` (a project API key) on the control service. Each GridZero user id is
the Composio user id.
