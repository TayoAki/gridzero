// A2UI (https://a2ui.org, Apache-2.0), protocol version 1.0: an agent describes a small interface as
// data, and the app draws it from components it already trusts. Nothing the agent sends is run as code.
//
// GridZero is the renderer. An agent sends a surface with the show_ui tool; the chat draws it; what the
// person does on it comes back to the agent as an A2UI action. This file checks every message before it
// is shown, and serves the catalog of what may be drawn.

import type { Hono } from "hono";
import { z } from "zod";

import { ToolError, registerTool } from "./agents/tools.ts";
import type { ClientTool } from "./agents/tools.ts";
import type { Vars } from "./app.ts";
import { env } from "./env.ts";
import { DESIGN_FORMS, THEMES, fits, widgetData } from "./widgets/spec.ts";

export const A2UI_VERSION = "1.0";
export const BASIC_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
/** GridZero's own catalog: one component, a chart drawn the way report cards are. */
export const GRIDZERO_CATALOG = "https://gridzero.app/a2ui/catalogs/report/v1/catalog.json";

/** The basic-catalog components GridZero draws. The rest (Video, AudioPlayer, Modal, DateTimeInput, Icon) are refused by name. */
export const BASIC_COMPONENTS = ["Text", "Image", "Row", "Column", "List", "Card", "Tabs", "Divider", "Button", "TextField", "CheckBox", "ChoicePicker", "Slider"] as const;
const COMPONENTS = new Set<string>([...BASIC_COMPONENTS, "GridZeroChart"]);

const MAX_MESSAGES = 20;
const MAX_COMPONENTS = 80;
const MAX_BYTES = 60_000;

const id = z.string().min(1).max(64);
const surfaceId = z.string().min(1).max(64).regex(/^[\w.-]+$/, "use letters, digits, dot, dash or underscore");
const component = z.object({ id, component: z.string().min(1).max(40) }).passthrough();
const pointer = z.string().max(300).regex(/^(\/|$)/, "a path is a JSON Pointer starting with /");

const message = z.union([
  z.object({ version: z.literal(A2UI_VERSION), createSurface: z.object({ surfaceId, catalogId: z.string().max(300).optional(), sendDataModel: z.boolean().optional(), components: z.array(component).max(MAX_COMPONENTS).optional(), dataModel: z.unknown().optional() }).strict() }).strict(),
  z.object({ version: z.literal(A2UI_VERSION), updateComponents: z.object({ surfaceId, components: z.array(component).min(1).max(MAX_COMPONENTS) }).strict() }).strict(),
  z.object({ version: z.literal(A2UI_VERSION), updateDataModel: z.object({ surfaceId, path: pointer.optional(), value: z.unknown().optional() }).strict() }).strict(),
  z.object({ version: z.literal(A2UI_VERSION), deleteSurface: z.object({ surfaceId }).strict() }).strict(),
]);
export type A2uiMessage = z.infer<typeof message>;

const isBinding = (v: unknown): boolean => typeof v === "object" && v !== null && ("@path" in v || "@call" in v);

/** Why these messages cannot be shown, or null. The first problem found, said so the agent can fix it. */
export function a2uiProblem(input: unknown): string | null {
  const parsed = z.array(message).min(1).max(MAX_MESSAGES).safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    return `messages${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}. Each message is {"version": "1.0"} plus exactly one of createSurface, updateComponents, updateDataModel, deleteSurface.`;
  }
  if (JSON.stringify(input).length > MAX_BYTES) return `The interface is larger than ${MAX_BYTES.toLocaleString("en-US")} characters. Show less, or put long tables in a report.`;
  const messages = parsed.data;
  const first = messages[0]!;
  if (!("createSurface" in first)) return "The first message must be createSurface.";
  const surface = first.createSurface.surfaceId;
  const catalog = first.createSurface.catalogId ?? BASIC_CATALOG;
  if (catalog !== BASIC_CATALOG && catalog !== GRIDZERO_CATALOG) return `catalogId must be ${BASIC_CATALOG} or ${GRIDZERO_CATALOG}.`;
  const seen = new Map<string, Record<string, unknown>>();
  for (const [n, m] of messages.entries()) {
    const body = "createSurface" in m ? m.createSurface : "updateComponents" in m ? m.updateComponents : "updateDataModel" in m ? m.updateDataModel : m.deleteSurface;
    if (body.surfaceId !== surface) return `Every message in one call is for one surface: message ${n} is for ${body.surfaceId}, not ${surface}.`;
    if (n > 0 && "createSurface" in m) return "A surface is created once.";
    const list = "createSurface" in m ? (m.createSurface.components ?? []) : "updateComponents" in m ? m.updateComponents.components : [];
    for (const c of list) {
      const why = componentProblem(c as Record<string, unknown>);
      if (why) return `Component ${c.id}: ${why}`;
      seen.set(c.id, c as Record<string, unknown>);
    }
  }
  if (seen.size > MAX_COMPONENTS) return `A surface holds at most ${MAX_COMPONENTS} components.`;
  if (!seen.has("root")) return 'One component must have the id "root".';
  // Every child named must exist: a missing one would leave a hole on screen.
  for (const c of seen.values()) {
    for (const ref of childIds(c)) if (!seen.has(ref)) return `Component ${String(c.id)} names a child, ${ref}, that is not defined.`;
  }
  return null;
}

function childIds(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof c.child === "string") out.push(c.child);
  if (Array.isArray(c.children)) out.push(...c.children.filter((x): x is string => typeof x === "string"));
  else if (c.children && typeof c.children === "object" && typeof (c.children as { componentId?: unknown }).componentId === "string") out.push((c.children as { componentId: string }).componentId);
  if (Array.isArray(c.tabs)) for (const t of c.tabs) if (t && typeof (t as { child?: unknown }).child === "string") out.push((t as { child: string }).child);
  return out;
}

function componentProblem(c: Record<string, unknown>): string | null {
  const kind = String(c.component);
  if (!COMPONENTS.has(kind)) return `${kind} is not drawn here. Use one of: ${[...COMPONENTS].join(", ")}.`;
  const own = c["@catalogId"];
  if (own !== undefined && own !== BASIC_CATALOG && own !== GRIDZERO_CATALOG) return "@catalogId names a catalog GridZero does not have.";
  if (kind === "Image") {
    // An image address is fetched by the person's browser: only https, and only written out, never worked out.
    if (typeof c.url !== "string" || !/^https:\/\//.test(c.url)) return "an image's url must be written out and start with https://";
  }
  if (kind === "Button") {
    const action = c.action as { event?: { name?: unknown }; functionCall?: { "@call"?: unknown; args?: { url?: unknown } } } | undefined;
    if (!action || (!action.event && !action.functionCall)) return "a Button needs an action: an event to send back, or the openUrl function.";
    if (action.event && typeof action.event.name !== "string") return "an action's event needs a name.";
    if (action.functionCall) {
      if (action.functionCall["@call"] !== "openUrl") return "the only function a Button may call is openUrl.";
      if (typeof action.functionCall.args?.url !== "string" || !/^https:\/\//.test(action.functionCall.args.url)) return "openUrl needs a url written out that starts with https://";
    }
  }
  if (kind === "GridZeroChart") {
    if (!DESIGN_FORMS.includes(c.form as (typeof DESIGN_FORMS)[number])) return `form must be one of ${DESIGN_FORMS.join(", ")}.`;
    if (c.theme !== undefined && !THEMES.includes(c.theme as (typeof THEMES)[number])) return `theme must be one of ${THEMES.join(", ")}.`;
    if (!isBinding(c.data)) {
      const data = widgetData.safeParse(c.data);
      if (!data.success) return `data is not chart data: ${data.error.issues[0]!.message}. It has the same shape as propose_widget's data.`;
      const why = fits(c.form as (typeof DESIGN_FORMS)[number], data.data);
      if (why) return why;
    }
  }
  return null;
}

/** GridZero's catalog, as an A2UI 1.0 catalog definition. */
export const gridzeroCatalog = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: GRIDZERO_CATALOG,
  catalogId: GRIDZERO_CATALOG,
  protocolVersion: A2UI_VERSION,
  title: "GridZero report components",
  description: "A chart drawn the way GridZero report cards are. Mixable with the basic catalog.",
  instructions: "Use GridZeroChart to show numbers as a figure, chart or table. Its data has the same shape as a report card's: a number, a series of label and value, or a table. Choose the form from the question: trend over time, hbar for a ranking, donut for shares.",
  components: {
    GridZeroChart: {
      type: "object",
      description: "One figure, chart or table, drawn by GridZero's chart builder.",
      properties: {
        component: { const: "GridZeroChart" },
        title: { $ref: "common_types.json#/$defs/DynamicString", description: "Shown above the chart." },
        form: { type: "string", enum: [...DESIGN_FORMS], description: "How the data is drawn." },
        theme: { type: "string", enum: [...THEMES], description: "The colour. Defaults to blue." },
        data: { $ref: "common_types.json#/$defs/DynamicValue", description: 'The data: {"kind":"number","value":…,"unit":…,"delta":…,"label":…}, {"kind":"series","points":[{"label":…,"value":…}]}, or {"kind":"table","columns":[…],"rows":[[…]]}.' },
        height: { type: "number", description: "Height in pixels, 120 to 480. Defaults to 240." },
      },
      required: ["component", "form", "data"],
    },
  },
  functions: {},
};

interface ShowInput {
  messages: unknown[];
}

const showUi: ClientTool<ShowInput> = {
  name: "show_ui",
  description: [
    "Show the user a small interface in the chat instead of only text: choices to pick from, a short form, or several figures and charts side by side. Use it when the user must choose or fill something in, or when an answer reads better as cards. Plain answers stay as text.",
    'The interface is A2UI 1.0 (a2ui.org). Send `messages`: the first is {"version":"1.0","createSurface":{"surfaceId":"<a new short id>","components":[…],"dataModel":{…}}}; later ones may be updateComponents, updateDataModel or deleteSurface for the same surface.',
    'Components are a flat list; each has "id" and "component" and names its children by id. One has the id "root".',
    `Components: ${BASIC_COMPONENTS.join(", ")} from the basic catalog, and GridZeroChart ({"component":"GridZeroChart","title":…,"form":<a propose_widget form>,"theme":…,"data":<propose_widget data>}).`,
    'Text takes "text" (Markdown) and "variant" body or caption. Row, Column and List take "children" (ids). Card takes "child". Button takes "child" (the id of a Text), "variant" primary, default or borderless, and "action".',
    'Inputs bind to the data model with {"@path":"/form/name"}: TextField (label, value, variant shortText, longText or number, placeholder), CheckBox (label, value), ChoicePicker (label, options [{"label","value"}], value, variant mutuallyExclusive or multipleSelection), Slider (label, min, max, value).',
    'A Button\'s action is {"event":{"name":"<what happened>","userMessage":"<what the user chose, in plain words>","context":{"period":{"@path":"/form/period"}}}}. When the user presses it you get a message ending "(A2UI action: {…})" with the name and the context filled in: act on it.',
    "Never put a secret, a password field or a payment field in an interface. Links and images must be https.",
  ].join(" "),
  inputSchema: { type: "object", properties: { messages: { type: "array", items: { type: "object" } } }, required: ["messages"], additionalProperties: false },
  schema: z.object({ messages: z.array(z.unknown()) }).strict() as z.ZodType<ShowInput>,
  readOnly: false,
  privateData: false,
  kinds: ["chat"],
  async run(input, ctx) {
    const problem = a2uiProblem(input.messages);
    if (problem) throw new ToolError(problem);
    const surface = (input.messages[0] as { createSurface: { surfaceId: string } }).createSurface.surfaceId;
    ctx.emit({ type: "a2ui", surfaceId: surface, messages: input.messages });
    return { surface_id: surface, status: "shown to the user" };
  },
  summary: () => "Showed an interface",
};

registerTool(showUi as ClientTool<any>);

export function routes(app: Hono<{ Variables: Vars }>) {
  /** GridZero's catalog, for any A2UI agent that wants to draw a chart here. */
  app.get("/api/v1/a2ui/catalog.json", (c) => c.json(gridzeroCatalog));

  /** What this renderer can draw, in the shape of A2UI's renderer capabilities. */
  app.get("/api/v1/a2ui/capabilities", (c) =>
    c.json({
      version: A2UI_VERSION,
      mimeType: "application/a2ui+json",
      rendererCapabilities: { supportedCatalogIds: [BASIC_CATALOG, GRIDZERO_CATALOG] },
      basicComponents: BASIC_COMPONENTS,
      notDrawn: ["Video", "AudioPlayer", "Modal", "DateTimeInput", "Icon"],
      catalog: `${env.publicUrl}/api/v1/a2ui/catalog.json`,
    }),
  );
}
