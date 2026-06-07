import { useState } from "react";
import { clearToken, getToken } from "./api/auth";
import LoginPage from "./pages/LoginPage";
import TreePage from "./pages/TreePage";

export default function App() {
  const [authenticated, setAuthenticated] = useState(!!getToken());

  function handleLogout() {
    clearToken();
    setAuthenticated(false);
  }

  return authenticated ? (
    <TreePage onLogout={handleLogout} />
  ) : (
    <LoginPage onLogin={() => setAuthenticated(true)} />
  );
}
