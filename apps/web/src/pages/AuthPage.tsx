import { useEffect, useState } from "react";
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
  const deleted = params.get("deleted") === "1";
  // Google is offered only where this server has its keys.
  const [google, setGoogle] = useState(false);
  useEffect(() => {
    fetch("/api/v1/auth/options").then((r) => r.json()).then((o: { google?: boolean }) => setGoogle(!!o.google), () => {});
  }, []);

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
        {deleted && !signup && <p className="collab-note" role="status">Your account has been deleted.</p>}
        {signup && (
          <p className="legal-consent">
            By signing up you agree to the <Link to="/terms" target="_blank">beta terms</Link> and the{" "}
            <Link to="/privacy" target="_blank">privacy notice</Link>.
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Please wait…" : signup ? "Sign up" : "Log in"}
        </button>
        {google && (
          <button type="button" className="secondary auth-google" disabled={busy} onClick={() => void authClient.signIn.social({ provider: "google", callbackURL: params.get("next") ?? "/" })}>
            Continue with Google
          </button>
        )}
        {!signup && <p className="switch"><Link to="/forgot-password">Forgot your password?</Link></p>}
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
