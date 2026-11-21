/**
 * Готовые строки CI для токена «только сигнал CI» (backend/app/code_changes.py): после
 * слияния в основную ветку CI сообщает ArchMap адрес репозитория, и проекты с объектами из
 * него напомнят человеку, что документацию пора обновить. Секрет в строки не вписывается:
 * его кладут в переменную ARCHMAP_TOKEN в настройках CI, строки на неё ссылаются.
 * Сбой ArchMap не должен ронять сборку, поэтому задание помечено как необязательное.
 */

export type CiTab = "gitlab" | "github" | "curl";

export const CI_TABS: { id: CiTab; label: string; hint: string }[] = [
  { id: "gitlab", label: "GitLab", hint: "Задание в .gitlab-ci.yml, токен в переменной ARCHMAP_TOKEN" },
  { id: "github", label: "GitHub", hint: "Workflow в .github/workflows, токен в секрете ARCHMAP_TOKEN" },
  { id: "curl", label: "curl", hint: "Для другого CI: подставьте адрес репозитория и коммит" },
];

/** Строки CI по вкладке; origin — адрес этого ArchMap (window.location.origin). */
export function ciSnippet(tab: CiTab, origin: string): string {
  const url = `${origin}/api/v1/code-changes`;
  switch (tab) {
    case "gitlab":
      return [
        "archmap:",
        "  stage: .post",
        "  allow_failure: true",
        "  rules:",
        "    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH",
        "  script:",
        "    - >",
        `      curl -fsS -X POST "${url}"`,
        '      -H "Authorization: Bearer $ARCHMAP_TOKEN"',
        '      -H "Content-Type: application/json"',
        '      -d "{\\"repo\\":\\"$CI_PROJECT_URL\\",\\"commit\\":\\"$CI_COMMIT_SHA\\",\\"branch\\":\\"$CI_COMMIT_BRANCH\\"}"',
      ].join("\n");
    case "github":
      return [
        "on:",
        "  push:",
        "    branches: [main]",
        "jobs:",
        "  archmap:",
        "    runs-on: ubuntu-latest",
        "    continue-on-error: true",
        "    steps:",
        "      - run: >",
        `          curl -fsS -X POST "${url}"`,
        '          -H "Authorization: Bearer ${{ secrets.ARCHMAP_TOKEN }}"',
        '          -H "Content-Type: application/json"',
        `          -d '{"repo":"\${{ github.server_url }}/\${{ github.repository }}","commit":"\${{ github.sha }}","branch":"\${{ github.ref_name }}"}'`,
      ].join("\n");
    case "curl":
      return [
        `curl -fsS -X POST "${url}" \\`,
        '  -H "Authorization: Bearer $ARCHMAP_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"repo":"<адрес репозитория>","commit":"<хэш коммита>","branch":"main"}'`,
      ].join("\n");
  }
}
