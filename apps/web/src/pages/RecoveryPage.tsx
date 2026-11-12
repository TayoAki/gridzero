// Forgot your password, and choosing a new one from the emailed link. Ported from DataDungeon's
// RecoveryForm (by the same author). The messages do not say whether an account exists for an address.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router";

import { authClient } from "../auth-client";

export function RecoveryPage({ reset = false }: { reset?: boolean }) {
  const [params] = useSearchParams();
  const token = params.get("token");
  const invalid = reset && (!token || !!params.get("error"));
  const [value, setValue] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  // Whether this server can send the email at all.
  const [available, setAvailable] = useState<boolean | null>(reset ? true : null);
  useEffect(() => {
    if (reset) return;
    fetch("/api/v1/auth/options").then((r) => r.json()).then((o: { passwordReset?: boolean }) => setAvailable(!!o.passwordReset), () => setAvailable(false));
  }, [reset]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (reset && value !== confirmation) return setError("The passwords do not match.");
    setBusy(true);
    try {
      const result = reset
        ? await authClient.resetPassword({ token: token!, newPassword: value })
        : await authClient.requestPasswordReset({ email: value.trim(), redirectTo: `${window.location.origin}/reset-password` });
      if (result.error) setError(reset ? "This reset link is invalid or expired. Request a new link." : "We could not process your request. Please try again later.");
      else setDone(true);
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card" aria-label="Account recovery">
        <h1>{reset ? "Choose a new password" : "Reset your password"}</h1>
        {invalid ? (
          <p role="alert">This reset link is invalid or expired. <Link to="/forgot-password">Request a new link</Link>.</p>
        ) : available === false ? (
          <p role="status">Password reset by email is not set up on this server yet. Ask whoever runs it to reset your password.</p>
        ) : done ? (
          <p role="status">{reset ? "Your password has been changed. Log in with your new password." : "If an account exists for this email, a reset link is on its way. Check your inbox and spam folder."}</p>
        ) : (
          <form onSubmit={submit} className="auth-recover">
            <p className="collab-note">{reset ? "Use at least 8 characters. Your other devices will be logged out." : "Enter your account email. Reset links expire after 30 minutes."}</p>
            <label className="field">
              {reset ? "New password" : "Email"}
              <input required type={reset ? "password" : "email"} minLength={reset ? 8 : undefined} maxLength={reset ? 128 : 254} autoComplete={reset ? "new-password" : "email"} value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
            {reset && (
              <label className="field">
                Confirm password
                <input required type="password" autoComplete="new-password" minLength={8} maxLength={128} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
              </label>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" type="submit" disabled={busy || available === null}>{busy ? "Please wait…" : reset ? "Change password" : "Send reset link"}</button>
          </form>
        )}
        <p className="auth-switch"><Link to="/login">Back to log in</Link></p>
      </div>
    </main>
  );
}
