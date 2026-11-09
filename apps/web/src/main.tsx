import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useSearchParams } from "react-router";

import { authClient } from "./auth-client";
import { AuthPage } from "./pages/AuthPage";
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
      <Route path="/login" element={email ? <AfterLogin /> : <AuthPage mode="login" />} />
      <Route path="/signup" element={email ? <AfterLogin /> : <AuthPage mode="signup" />} />
      <Route path="/" element={email ? <HomePage email={email} /> : <Navigate to="/login" replace />} />
      <Route path="/trash" element={email ? <TrashPage /> : <ToLogin />} />
      <Route path="/invite/:token" element={email ? <InvitePage /> : <ToLogin />} />
      <Route path="/workbook/:id" element={email ? <WorkbookPage /> : <ToLogin />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
