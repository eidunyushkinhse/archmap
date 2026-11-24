/**
 * Готовые строки CI для токена «только сигнал CI» (backend/app/code_changes.py): после
 * слияния в основную ветку CI сообщает ArchMap адрес репозитория, и проекты с объектами из
 * него напомнят человеку, что документацию пора обновить. Секрет в строки не вписывается:
 * его кладут в переменную ARCHMAP_TOKEN в настройках CI, строки на неё ссылаются.
 * Сбой ArchMap не должен ронять сборку, поэтому задание помечено как необязательное: при
 * отказе оно завершается с ошибкой, и пайплайн показывает предупреждение.
 *
 * Команда (находка 5, 2026-11-24): ответ ArchMap идёт в журнал всегда (тело в stderr), код
 * ответа — в переменную, и задание падает на коде 400 и выше. Ключ -f глушил текст отказа
 * («Токен недействителен…»), а --fail-with-body есть только с curl 7.76: в образах Debian 11,
 * RHEL 8 и Ubuntu 20.04 его нет. Недоступный адрес роняет сам curl, и && не пускает дальше.
 * GitHub шлёт сигнал при push в основную ветку репозитория, как бы она ни называлась.
 */

export type CiTab = "gitlab" | "github" | "curl";

export const CI_TABS: { id: CiTab; label: string; hint: string }[] = [
  { id: "gitlab", label: "GitLab", hint: "Задание в .gitlab-ci.yml, токен в переменной ARCHMAP_TOKEN" },
  { id: "github", label: "GitHub", hint: "Workflow в .github/workflows, токен в секрете ARCHMAP_TOKEN" },
  { id: "curl", label: "curl", hint: "Для другого CI: подставьте адрес репозитория, коммит и ветку" },
];

// Начало и конец команды: ответ ArchMap в журнал, код ответа в переменную, проверка кода.
const curlHead = (url: string) => `code=$(curl -sS -o /dev/stderr -w "%{http_code}" -X POST "${url}"`;
const CODE_CHECK = '&& test "$code" -lt 400';

/** Строки CI по вкладке; origin — адрес этого ArchMap (window.location.origin). */
export function ciSnippet(tab: CiTab, origin: string): string {
  const url = `${origin}/api/v1/code-changes`;
  switch (tab) {
    case "gitlab":
      // Свёрнутый скаляр «>»: строки ниже склеиваются пробелом в одну команду.
      return [
        "archmap:",
        "  stage: .post",
        "  allow_failure: true",
        "  rules:",
        "    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH",
        "  script:",
        "    - >",
        `      ${curlHead(url)}`,
        '      -H "Authorization: Bearer $ARCHMAP_TOKEN"',
        '      -H "Content-Type: application/json"',
        '      -d "{\\"repo\\":\\"$CI_PROJECT_URL\\",\\"commit\\":\\"$CI_COMMIT_SHA\\",\\"branch\\":\\"$CI_COMMIT_BRANCH\\"}")',
        `      ${CODE_CHECK}`,
      ].join("\n");
    case "github":
      return [
        "on: push",
        "jobs:",
        "  archmap:",
        "    if: github.ref_name == github.event.repository.default_branch",
        "    runs-on: ubuntu-latest",
        "    continue-on-error: true",
        "    steps:",
        "      - run: >",
        `          ${curlHead(url)}`,
        '          -H "Authorization: Bearer ${{ secrets.ARCHMAP_TOKEN }}"',
        '          -H "Content-Type: application/json"',
        `          -d '{"repo":"\${{ github.server_url }}/\${{ github.repository }}","commit":"\${{ github.sha }}","branch":"\${{ github.ref_name }}"}')`,
        `          ${CODE_CHECK}`,
      ].join("\n");
    case "curl":
      return [
        `${curlHead(url)} \\`,
        '  -H "Authorization: Bearer $ARCHMAP_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"repo":"<адрес репозитория>","commit":"<хэш коммита>","branch":"<ветка>"}') ${CODE_CHECK}`,
      ].join("\n");
  }
}
