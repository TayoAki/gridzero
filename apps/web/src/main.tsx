import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useSearchParams } from "react-router";

import { authClient } from "./auth-client";
import { AgentChatPage } from "./agents/AgentChatPage";
import { AgentsPage } from "./agents/AgentsPage";
import { AiSettingsPage } from "./agents/AiSettingsPage";
import { ErrorBoundary, installErrorReporting } from "./errors";
import { AccountPage } from "./pages/AccountPage";
import { AuthPage } from "./pages/AuthPage";
import { LegalPage } from "./pages/LegalPage";
import { HomePage } from "./pages/HomePage";
import { InvitePage } from "./pages/InvitePage";
import { TrashPage } from "./pages/TrashPage";
import { WorkbookPage } from "./pages/WorkbookPage";
import "./styles.css";

/** Only same-site paths: `next` comes from the URL. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

function ToLogin() {
  const { pathname, search } = useLocation();
  return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />;
}

function AfterLogin() {
  const [params] = useSearchParams();
  return <Navigate to={safeNext(params.get("next"))} replace />;
}

function App() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return null;
  const email = session?.user.email;
  return (
    <Routes>
      {/* Keys keep the two forms apart, so text typed on one does not carry to the other. */}
      <Route path="/login" element={email ? <AfterLogin /> : <AuthPage key="login" mode="login" />} />
      <Route path="/signup" element={email ? <AfterLogin /> : <AuthPage key="signup" mode="signup" />} />
      <Route path="/" element={email ? <HomePage email={email} /> : <Navigate to="/login" replace />} />
      <Route path="/trash" element={email ? <TrashPage /> : <ToLogin />} />
      <Route path="/invite/:token" element={email ? <InvitePage /> : <ToLogin />} />
      <Route path="/workbook/:id" element={email ? <WorkbookPage /> : <ToLogin />} />
      <Route path="/account" element={email ? <AccountPage email={email} /> : <ToLogin />} />
      <Route path="/agents" element={email ? <AgentsPage /> : <ToLogin />} />
      <Route path="/agents/:id" element={email ? <AgentChatPage /> : <ToLogin />} />
      <Route path="/settings/ai" element={email ? <AiSettingsPage /> : <ToLogin />} />
      <Route path="/terms" element={<LegalPage doc="terms" />} />
      <Route path="/privacy" element={<LegalPage doc="privacy" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

installErrorReporting();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
