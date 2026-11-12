// Account settings: who you are signed in as, and deleting the account.

import { Models, Tokens } from "../insight/Outside";
import { useState } from "react";
import type { FormEvent } from "react";

import { authClient } from "../auth-client";

export function AccountPage({ email }: { email: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function deleteAccount(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/account", {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, confirm }),
    });
    if (res.ok) {
      await authClient.signOut().catch(() => {});
      location.assign("/login?deleted=1");
      return;
    }
    setBusy(false);
    setError((await res.json().catch(() => null))?.error ?? `Could not delete the account (${res.status})`);
  }

  return (
    <main className="account-page">
      <h1>Account</h1>
      <p>Signed in as <strong>{email}</strong>.</p>

      <Tokens />
      <Models />
      <section className="danger-zone" aria-labelledby="delete-account">
        <h2 id="delete-account">Delete your account</h2>
        <p>
          This deletes your account, every workbook you own (including ones in the trash), the people you shared them
          with, and your saved database connections. Workbooks other people shared with you stay theirs. It cannot be
          undone. Copies in our backups are removed as the backups expire, within 90 days.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <form onSubmit={deleteAccount} className="danger-form">
          <label className="field">
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <label className="field">
            Type DELETE to confirm
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" required />
          </label>
          <button className="danger-button" type="submit" disabled={busy || confirm !== "DELETE" || !password}>
            {busy ? "Deleting…" : "Delete my account"}
          </button>
        </form>
      </section>
    </main>
  );
}
