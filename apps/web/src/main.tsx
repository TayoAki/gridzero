import { ActivityPage } from "./insight/ActivityPage";
import { AdminPage } from "./insight/AdminPage";
import { RecoveryPage } from "./pages/RecoveryPage";
import { SqlPage } from "./sql/SqlPage";
import { NeedsYouPage } from "./pages/NeedsYouPage";
import { PublicReportPage, ReportInvitePage } from "./widgets/PublicReportPage";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useSearchParams } from "react-router";

import { authClient } from "./auth-client";
import { AgentChatPage } from "./agents/AgentChatPage";
import { AgentsPage } from "./agents/AgentsPage";
import { AiSettingsPage } from "./agents/AiSettingsPage";
import { MetricsPage } from "./agents/MetricsPage";
import { AppsPage } from "./agents/AppsPage";
import { DefinitionsPage } from "./definitions/DefinitionsPage";
import { DashboardPage, PresentPage } from "./widgets/DashboardPage";
import { ErrorBoundary, installErrorReporting } from "./errors";
import { AccountPage } from "./pages/AccountPage";
import { AuthPage } from "./pages/AuthPage";
import { LegalPage } from "./pages/LegalPage";
import { HomePage } from "./pages/HomePage";
import { InvitePage } from "./pages/InvitePage";
import { TrashPage } from "./pages/TrashPage";
import { WorkbookPage } from "./pages/WorkbookPage";
import { PreviewPage } from "./preview/PreviewPage";
import { Shell, applyTheme } from "./shell/Shell";
import "./styles.css";
import "./shell/shell.css";

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
      <Route path="/forgot-password" element={<RecoveryPage />} />
      <Route path="/reset-password" element={<RecoveryPage reset />} />
      <Route path="/invite/:token" element={email ? <InvitePage /> : <ToLogin />} />
      <Route path="/dashboards/:id/present" element={email ? <PresentPage /> : <ToLogin />} />
      <Route path="/report-invite/:token" element={email ? <ReportInvitePage /> : <ToLogin />} />
      {/* A report's view link: no account needed. */}
      <Route path="/r/:token" element={<PublicReportPage />} />
      {/* Every signed-in page sits inside the shell: rail, list, tabs, agent panel and bottom bar. */}
      <Route element={email ? <Shell email={email} /> : <ToLogin />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/needs-you" element={<NeedsYouPage />} />
        <Route path="/sql" element={<SqlPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/trash" element={<TrashPage />} />
        <Route path="/workbook/:id" element={<WorkbookPage />} />
        <Route path="/account" element={<AccountPage email={email ?? ""} />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/:id" element={<AgentChatPage />} />
        <Route path="/dashboards" element={<DashboardPage />} />
        <Route path="/dashboards/:id" element={<DashboardPage />} />
        <Route path="/apps" element={<AppsPage />} />
        <Route path="/definitions" element={<DefinitionsPage />} />
        <Route path="/definitions/:sourceId" element={<DefinitionsPage />} />
        <Route path="/metrics" element={<MetricsPage />} />
        <Route path="/settings/ai" element={<AiSettingsPage />} />
        <Route path="/preview" element={<PreviewPage />} />
        <Route path="/preview/:code" element={<PreviewPage />} />
      </Route>
      <Route path="/terms" element={<LegalPage doc="terms" />} />
      <Route path="/privacy" element={<LegalPage doc="privacy" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

installErrorReporting();
try {
  applyTheme((JSON.parse(localStorage.getItem("gz_theme") ?? '"system"') as "system" | "light" | "dark") ?? "system");
} catch {
  // The default theme follows the system.
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
