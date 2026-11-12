/**
 * The notebook's syntax colours (research/03 §2.3): which highlight tags get which colour, as CSS variables so light and
 * dark both work. The editor builds its HighlightStyle from these rules (./CodeEditor.tsx), and the home page's live
 * lesson colours its static, pre-editor code with the same rules (src/components/marketing/static-code.ts), so nothing
 * changes colour when the editor loads. Plain module (no "use client"): server components read it too.
 */
import { tags as t, type Tag } from "@lezer/highlight";

export interface SyntaxRule {
  tag: Tag | readonly Tag[];
  color?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
}

export const SYNTAX_RULES: SyntaxRule[] = [
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--syn-keyword)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)" },
  { tag: [t.operator, t.punctuation, t.separator], color: "var(--syn-operator)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.typeName, t.className, t.standard(t.name)], color: "var(--syn-function)" },
  { tag: t.heading, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.link, color: "var(--db-md-link)", textDecoration: "underline" },
  { tag: t.meta, color: "var(--syn-default)" },
];
