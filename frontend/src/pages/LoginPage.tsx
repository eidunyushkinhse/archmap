import { useState } from "react";
import { login, saveToken } from "../api/auth";

interface Props {
  onLogin: () => void;
  // Почему сессию закрыли без спроса (например, «Учётная запись заблокирована»):
  // показывается на месте ошибки входа, пока человек не попробует войти снова.
  notice?: string | null;
}

export default function LoginPage({ onLogin, notice = null }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(notice);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const token = await login(username, password);
      saveToken(token.access_token);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка входа");
    }
  }

  return (
    <div style={{ maxWidth: 320, margin: "100px auto" }}>
      <h2>ArchMap — вход</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <input
            placeholder="Логин"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div>
          <input
            type="password"
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p style={{ color: "red" }}>{error}</p>}
        <button type="submit">Войти</button>
      </form>
    </div>
  );
}
