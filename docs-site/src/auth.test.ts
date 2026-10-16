// Авторизация: пароль, токен сессии, cookie, лимит попыток.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { hashPassword, issueToken, loadAuthConfig, parseCookies, RateLimiter, verifyPassword, verifyToken } from "./auth.ts";

describe("пароль", () => {
  it("хэш scrypt проверяется, чужой пароль и мусор — нет", () => {
    const stored = hashPassword("correct horse");
    assert.match(stored, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
    assert.equal(verifyPassword("correct horse", stored), true);
    assert.equal(verifyPassword("wrong", stored), false);
    assert.equal(verifyPassword("correct horse", "plain:x"), false);
  });
});

describe("сессия", () => {
  const secret = randomBytes(32);

  it("токен проходит со своим ключом, не проходит с чужим, истёкший и порченый", () => {
    const token = issueToken(secret);
    assert.equal(verifyToken(secret, token), true);
    assert.equal(verifyToken(randomBytes(32), token), false);
    assert.equal(verifyToken(secret, token, Date.now() + 91 * 24 * 3600 * 1000), false);
    assert.equal(verifyToken(secret, `${token}x`), false);
    assert.equal(verifyToken(secret, undefined), false);
    assert.equal(verifyToken(secret, "a.b"), false);
  });

  it("cookie разбираются, ключ сессий создаётся в папке данных и переживает перезапуск", () => {
    assert.deepEqual(parseCookies("a=1; docs_session=x%2Ey; b"), { a: "1", docs_session: "x.y" });
    const dir = mkdtempSync(join(tmpdir(), "archmap-docs-auth-"));
    try {
      const env = { DOCS_AUTHOR_PASSWORD: "secret-pw" } as NodeJS.ProcessEnv;
      const a = loadAuthConfig(dir, env);
      const b = loadAuthConfig(dir, env);
      assert.equal(a.secret.toString("hex"), b.secret.toString("hex"));
      assert.equal(readFileSync(join(dir, "session-secret"), "utf8").length, 64);
      assert.ok(a.passwordHash && verifyPassword("secret-pw", a.passwordHash));
      assert.equal(loadAuthConfig(dir, {} as NodeJS.ProcessEnv).passwordHash, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("лимит попыток", () => {
  it("пять попыток в окно, шестая — отказ, окно истекает, сброс по успеху", () => {
    const rl = new RateLimiter(5, 1000);
    for (let i = 0; i < 5; i++) assert.equal(rl.hit("ip", 0), true);
    assert.equal(rl.hit("ip", 0), false);
    assert.equal(rl.hit("ip", 1001), true);
    rl.reset("ip");
    assert.equal(rl.hit("ip", 1001), true);
  });
});
