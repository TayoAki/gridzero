// Auth (BUILD-SPEC D13): email and password, a password reset by email when email is set up, and Google
// sign-in when a client id and secret are set. The reset flow follows DataDungeon's (src/server/auth.ts
// and recovery-email.ts, by the same author).

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";

import { db } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { env } from "./env.ts";
import { mailEnabled, sendMail } from "./mail.ts";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What the sign-in page can offer on this server. */
const oidc = !!(env.oidcDiscoveryUrl && env.oidcClientId && env.oidcClientSecret);
export const authOptions = () => ({ passwordReset: mailEnabled(), google: !!(env.googleClientId && env.googleClientSecret), company: oidc ? env.oidcName : null });

export const auth = betterAuth({
  baseURL: env.publicUrl,
  secret: env.authSecret,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // A reset link works once, for half an hour, and signs every other device out.
    resetPasswordTokenExpiresIn: 1800,
    revokeSessionsOnPasswordReset: true,
    ...(mailEnabled()
      ? {
          sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
            // Never log the link or who asked: the link is a way into the account.
            const sent = await sendMail({
              to: user.email,
              subject: "Reset your GridZero password",
              html: `<p>Someone asked to reset the password for this GridZero account. If it was you, choose a new password:</p><p><a href="${escape(url)}">Choose a new password</a></p><p>The link works once and expires in 30 minutes. If it was not you, ignore this message: nothing has changed.</p>`,
            }).catch(() => false);
            if (!sent) console.error("password reset email could not be sent");
          },
        }
      : {}),
  },
  ...(env.googleClientId && env.googleClientSecret ? { socialProviders: { google: { clientId: env.googleClientId, clientSecret: env.googleClientSecret } } } : {}),
  // Company sign-in: any identity provider that speaks OpenID Connect. Its callback is /api/auth/callback/company.
  ...(oidc ? { plugins: [genericOAuth({ config: [{ providerId: "company", clientId: env.oidcClientId!, clientSecret: env.oidcClientSecret!, discoveryUrl: env.oidcDiscoveryUrl!, scopes: ["openid", "email", "profile"], accountSubject: ({ profile }: { profile: { sub?: unknown; id?: unknown } }) => String(profile.sub ?? profile.id ?? "") }] })] } : {}),
  trustedOrigins: [env.publicUrl, "http://localhost:5173"],
});

export type Session = typeof auth.$Infer.Session;
