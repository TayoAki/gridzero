// Email through Resend. Without RESEND_API_KEY nothing is sent: an owner shares an invitation
// link by hand, and an emailed report or an alert says that email is not set up.

import { env } from "./env.ts";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function sendInvite(invite: { to: string; from: string; title: string; role: string; url: string }): Promise<boolean> {
  if (!env.resendApiKey) return false;
  const verb = invite.role === "editor" ? "edit" : "view";
  const res = await fetch(`${env.resendBaseUrl}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.mailFrom,
      to: invite.to,
      subject: `${invite.from} shared "${invite.title}" with you`,
      html: `<p>${escape(invite.from)} invited you to ${verb} <strong>${escape(invite.title)}</strong> on GridZero.</p><p><a href="${escape(invite.url)}">Open the workbook</a></p>`,
    }),
  }).catch((e: unknown) => {
    console.error("invite email failed", e);
    return null;
  });
  if (res && !res.ok) console.error("invite email rejected", res.status, await res.text());
  return !!res?.ok;
}

export const mailEnabled = () => !!env.resendApiKey;

/** Send one message to one or more people. False when email is not set up or the send failed. */
export async function sendMail(mail: { to: string | string[]; subject: string; html: string }): Promise<boolean> {
  if (!env.resendApiKey) return false;
  const res = await fetch(`${env.resendBaseUrl}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.mailFrom, to: mail.to, subject: mail.subject.slice(0, 200), html: mail.html }),
  }).catch((e: unknown) => {
    console.error("email failed", e);
    return null;
  });
  if (res && !res.ok) console.error("email rejected", res.status, await res.text());
  return !!res?.ok;
}
