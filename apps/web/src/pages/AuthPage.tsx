import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router";

import { authClient } from "../auth-client";

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  const suffix = params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } =
      mode === "signup"
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password });
    // On success the session updates and the router redirects to "/" by itself.
    if (error) {
      setBusy(false);
      setError(error.message ?? "Something went wrong");
    }
  }

  const signup = mode === "signup";
  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>{signup ? "Create your account" : "Log in"}</h1>
        <p className="sub">{signup ? "Start analysing big data in a spreadsheet." : "Welcome back to GridZero."}</p>
        {error && <p className="error" role="alert">{error}</p>}
        {signup && (
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
        )}
        <label className="field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={signup ? "new-password" : "current-password"}
            minLength={8}
            required
          />
        </label>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Please wait…" : signup ? "Sign up" : "Log in"}
        </button>
        <p className="switch">
          {signup ? (
            <>Already have an account? <Link to={`/login${suffix}`}>Log in</Link></>
          ) : (
            <>New to GridZero? <Link to={`/signup${suffix}`}>Create an account</Link></>
          )}
        </p>
      </form>
    </main>
  );
}
