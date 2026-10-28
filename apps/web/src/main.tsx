import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { authClient } from "./auth-client";
import { AuthPage } from "./pages/AuthPage";
import { HomePage } from "./pages/HomePage";
import "./styles.css";

function App() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return null;
  const email = session?.user.email;
  return (
    <Routes>
      <Route path="/login" element={email ? <Navigate to="/" replace /> : <AuthPage mode="login" />} />
      <Route path="/signup" element={email ? <Navigate to="/" replace /> : <AuthPage mode="signup" />} />
      <Route path="/" element={email ? <HomePage email={email} /> : <Navigate to="/login" replace />} />
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
