# Развёртывание ArchMap

ArchMap разворачивается в OpenShift или Kubernetes из готового образа либо на обычный
Linux-сервер из архива. Интернет при установке не нужен, внешних запросов приложение
не делает.

- [OpenShift и Kubernetes](#openshift-и-kubernetes) — образ и манифесты, nginx не нужен.
- [Сервер без Kubernetes](#сервер-без-kubernetes) — архив с переносным Python, служба
  systemd и nginx.

## Что нужно в любом случае

**PostgreSQL**
- Версия 15 или новее: схема использует `UNIQUE … NULLS NOT DISTINCT`. Проверено на 15.15 и 16.
- Отдельная база в UTF-8; пользователь ArchMap — её владелец. Расширения не нужны.
- ArchMap должен достучаться до PostgreSQL по сети.

**Адрес**
- Своё DNS-имя для ArchMap: приложение работает от корня адреса, подпуть вида
  `https://portal/archmap/` не поддерживается.
- TLS: по сети ходят пароли и токены входа.

## Подготовка базы (для администратора PostgreSQL)

```sql
CREATE ROLE archmap LOGIN PASSWORD '…';
CREATE DATABASE archmap OWNER archmap ENCODING 'UTF8' TEMPLATE template0;
```

И разрешить в `pg_hba.conf` подключение пользователя `archmap` к базе `archmap` с адресов,
откуда ходит ArchMap: узлов кластера или сервера. Таблицы ArchMap создаст сам.

В адресе базы спецсимволы пароля кодируются: `@` → `%40`, `:` → `%3A`, `/` → `%2F`,
`%` → `%25`, `#` → `%23`, `?` → `%3F`. Если PostgreSQL требует TLS, допишите к адресу
`?sslmode=require`.

## OpenShift и Kubernetes

В поде один процесс отдаёт и API, и интерфейс. Снаружи — Route с TLS на роутере. Перед
стартом приложения init-контейнер проверяет базу и применяет миграции.

### Что нужно

- Проект (namespace) с правами на создание Deployment, Service, Route, Secret и ConfigMap
  и на `oc exec`: роль `edit` или `admin`.
- Реестр, из которого кластер берёт образы: внутренний реестр OpenShift или реестр контура.
  На машине, с которой образ туда загружают, — Docker, Podman или skopeo.
- Сетевой доступ из подов к PostgreSQL: сетевые политики и межсетевые экраны.
- Квота: на под 0,2 CPU и 512 МБ в запросах, до 2 CPU и 1 ГБ в лимитах.
- Только x86_64.

### Сборка

На машине с интернетом, Docker или Podman и всем, что нужно для сборки поставки
(Linux x86_64, git, Node.js 22+, curl), из репозитория:

```bash
deploy/build-image.sh
```

Получится `dist-bundle/archmap-<дата>-<коммит>-openshift.tar.gz` (около 100 МБ) и файл с его
контрольной суммой. Внутри — образ `archmap-image.tar` (формат `docker save`), манифесты
`openshift/` с уже проставленной версией образа и эта инструкция.

Базовый образ — Red Hat UBI 9 minimal. Свой базовый образ (Linux x86_64 с glibc 2.17+,
zlib и libstdc++): `BASE_IMAGE=… deploy/build-image.sh`.

Если образы в контуре разрешено собирать только своими средствами, рядом лежит обычная
поставка `archmap-<дата>-<коммит>-linux-x86_64.tar.gz`: она же контекст сборки. Внутри
контура, без интернета, нужен только базовый образ:

```bash
tar -xzf archmap-*-linux-x86_64.tar.gz && cd archmap-*-linux-x86_64
docker build -f deploy/openshift/Dockerfile --build-arg BASE_IMAGE=… -t archmap:$(cat VERSION) .
```

### Установка

1. Проверьте и распакуйте пакет:
   ```bash
   sha256sum -c archmap-*-openshift.tar.gz.sha256
   tar -xzf archmap-*-openshift.tar.gz && cd archmap-*-openshift
   ```
2. Загрузите образ в реестр — skopeo или Docker (у Podman те же команды, что у Docker):
   ```bash
   skopeo copy docker-archive:archmap-image.tar \
     docker://registry.example.local/archmap/archmap:$(cat VERSION)
   ```
   ```bash
   docker load -i archmap-image.tar
   docker tag archmap:$(cat VERSION) registry.example.local/archmap/archmap:$(cat VERSION)
   docker push registry.example.local/archmap/archmap:$(cat VERSION)
   ```
   Внутренний реестр OpenShift принимает образы через маршрут `default-route` в проекте
   `openshift-image-registry`, если администраторы кластера его открыли. Вход:
   `docker login -u $(oc whoami) -p $(oc whoami -t) <адрес маршрута>`. Изнутри кластера
   образ тогда называется `image-registry.openshift-image-registry.svc:5000/<проект>/archmap`.
3. Впишите адрес образа без версии в `openshift/kustomization.yaml` (`images` → `newName`).
   Своё имя хоста — `spec.host` в `openshift/route.yaml`; без него OpenShift выдаст имя вида
   `archmap-<проект>.apps.<домен кластера>`.
4. Создайте секрет с адресом базы и ключом подписи токенов:
   ```bash
   oc project <проект>
   oc create secret generic archmap-secrets \
     --from-literal=DATABASE_URL='postgresql://archmap:ПАРОЛЬ@pg.example.local:5432/archmap' \
     --from-literal=SECRET_KEY="$(openssl rand -hex 32)"
   ```
   Без openssl ключ даст `python3 -c "import secrets; print(secrets.token_hex(32))"`.
5. Примените манифесты и дождитесь запуска:
   ```bash
   oc apply -k openshift/
   oc rollout status deploy/archmap
   ```
6. Создайте первого администратора — пароль команда спросит дважды:
   ```bash
   oc exec -it deploy/archmap -- python3 -m app.admin create-admin <логин>
   ```
7. Адрес покажет `oc get route archmap`. Откройте его, войдите и заведите людей на экране
   «Пользователи» (меню профиля). Почты нет: временный пароль администратор передаёт
   сам, человек меняет его в меню профиля.

### Что где

| Объект | Что это |
|---|---|
| Deployment `archmap` | под: init-контейнер `migrate` (проверка базы и миграции) и приложение на порту 8080 |
| Service и Route `archmap` | вход снаружи: TLS на роутере, http → https, ответ до 300 с |
| Secret `archmap-secrets` | `DATABASE_URL` и `SECRET_KEY`; создаётся командой, в файлах его нет |
| ConfigMap `archmap-settings-<хэш>` | несекретные настройки из `openshift/settings.env` |

### Настройки

Несекретные — в `openshift/settings.env`. После правки выполните `oc apply -k openshift/`:
поды перезапустятся сами.

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `ALLOW_SIGNUP` | `false` | самостоятельная регистрация; в закрытом контуре выключена |
| `WEB_CONCURRENCY` | `2` | рабочих процессов в поде |
| `LOGIN_ATTEMPTS_PER_MINUTE` | `10` | неудачных попыток входа в минуту с адреса, дальше отказ; `0` — без ограничения |
| `MAX_REQUEST_MB` | `64` | предел размера запроса (ввоз архива проекта) |

`DATABASE_URL` и `SECRET_KEY` живут в секрете: после правки выполните
`oc rollout restart deploy/archmap`. Смена `SECRET_KEY` разлогинит всех.

Каждый рабочий процесс держит до 15 соединений с PostgreSQL. Сверьте
`max_connections` базы с произведением «реплики × WEB_CONCURRENCY × 15».

Попытки входа каждый процесс считает сам. Поэтому реальный предел — значение
`LOGIN_ATTEMPTS_PER_MINUTE`, умноженное на число процессов во всех подах. Удачные входы
не считаются.

### Обновление

1. Сделайте резервную копию базы (см. ниже).
2. Загрузите образ новой версии в реестр, как в шаге 2 установки.
3. Поменяйте версию (`newTag`) в своём `openshift/kustomization.yaml` и выполните
   `oc apply -k openshift/`.

Свою копию каталога `openshift/` удобно хранить отдельно: при обновлении в ней меняется
только `newTag`. Под пересоздаётся: старый останавливается, новый применяет миграции и
стартует. Перерыв — несколько секунд.

**Откат.** Верните прежний `newTag` и выполните `oc apply -k openshift/`. Если новая версия
уже изменила схему базы, сначала восстановите базу из резервной копии.

### Если что-то не так

- **Под в `Init:Error` или `Init:CrashLoopBackOff`.** Init-контейнер не прошёл проверку
  базы или миграции: `oc logs <под> -c migrate`. Сообщение «БАЗА: …» называет, что
  поправить: подключение, версию, кодировку или права.
- **`ImagePullBackOff`.** Неверный адрес образа в `kustomization.yaml` или у проекта нет
  доступа к реестру (pull secret).
- **`CreateContainerConfigError`.** Нет секрета `archmap-secrets`.
- **Долгий ввоз обрывается.** Роутер ждёт ответа 300 с: аннотация
  `haproxy.router.openshift.io/timeout` в `route.yaml`.
- **«Слишком много попыток входа».** Если все пользователи приходят через один прокси
  (один адрес), поднимите `LOGIN_ATTEMPTS_PER_MINUTE`.
- **Администратор потерял доступ.**
  `oc exec -it deploy/archmap -- python3 -m app.admin create-admin <логин> --reset-password`:
  команда делает пользователя администратором, снимает блокировку и задаёт новый пароль.
- **Журнал приложения.** `oc logs deploy/archmap`.

### Kubernetes без OpenShift

Команды те же, с `kubectl` вместо `oc`. Route в Kubernetes нет: уберите `route.yaml` из
`kustomization.yaml` и опубликуйте Service своим Ingress. Нужны TLS, ответ до 300 с, тело
запроса до 64 МБ и адрес клиента последним в `X-Forwarded-For`: по нему считаются попытки
входа.

## Сервер без Kubernetes

ArchMap ставится на голый Linux-сервер из одного архива. На сервере не нужны ни Python,
ни Node.js: в поставке переносной Python со всеми зависимостями, бэкенд и собранный фронт.

### Что нужно

- Linux x86_64 с systemd и glibc 2.17 или новее (подходит любой дистрибутив последних лет).
- root или sudo на время установки.
- nginx из репозитория дистрибутива. Если перед сервером уже стоит свой обратный прокси,
  можно обойтись без nginx (см. «Без nginx»).
- 1–2 ГБ памяти, около 1 ГБ на диске: установщик хранит три последних релиза по ~220 МБ.

### Сборка поставки

На машине с интернетом (Linux x86_64, git, Node.js 22+, curl), из репозитория:

```bash
deploy/build-bundle.sh
```

Получится `dist-bundle/archmap-<дата>-<коммит>-linux-x86_64.tar.gz` (около 55 МБ) и файл
с его контрольной суммой. Поставка собирается из закоммиченного состояния; пробная сборка
с незакоммиченными правками — `deploy/build-bundle.sh --worktree`.

### Установка

1. Перенесите архив и `.sha256` на сервер и проверьте целостность:
   ```bash
   sha256sum -c archmap-*.tar.gz.sha256
   tar -xzf archmap-*.tar.gz && cd archmap-*-linux-x86_64
   ```
2. Запустите установщик:
   ```bash
   sudo ./deploy/install.sh --server-name archmap.example.local \
     --tls-cert /etc/ssl/archmap.crt --tls-key /etc/ssl/archmap.key
   ```
   Без TLS (только для тестового сегмента) — без двух последних параметров.
   Первый запуск создаёт `/etc/archmap/archmap.env` со случайным `SECRET_KEY` и останавливается.
3. Впишите в `/etc/archmap/archmap.env` адрес базы:
   ```
   DATABASE_URL=postgresql://archmap:ПАРОЛЬ@pg.example.local:5432/archmap
   ```
4. Запустите ту же команду ещё раз. Установщик проверит базу (версию, кодировку, права),
   применит миграции, разложит релиз в `/opt/archmap`, запустит службу `archmap` и настроит nginx.
5. Создайте первого администратора — пароль команда спросит дважды:
   ```bash
   sudo archmap-admin create-admin <логин>
   ```
6. Откройте `https://archmap.example.local`, войдите и заведите людей на экране
   «Пользователи».

### Что где лежит

| Путь | Что это |
|---|---|
| `/opt/archmap/releases/<версия>` | релизы (хранятся три последних) |
| `/opt/archmap/current` | ссылка на работающий релиз |
| `/etc/archmap/archmap.env` | настройки (права 640, root:archmap) |
| `/etc/systemd/system/archmap.service` | служба; работает от пользователя `archmap` |
| `/etc/nginx/conf.d/archmap.conf` | сайт в nginx |
| `/usr/local/bin/archmap-admin` | команды администрирования |

### Настройки

Файл `/etc/archmap/archmap.env`, после правки — `sudo systemctl restart archmap`.

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `DATABASE_URL` | — | адрес PostgreSQL |
| `SECRET_KEY` | случайный | подпись токенов входа; смена ключа разлогинит всех |
| `ALLOW_SIGNUP` | `false` | самостоятельная регистрация; в закрытом контуре выключена |
| `CORS_ORIGINS` | адрес из `--server-name` | адрес, с которого открывают ArchMap |
| `ARCHMAP_PORT` | `8000` | порт бэкенда на 127.0.0.1 (к нему ходит nginx) |
| `ARCHMAP_WORKERS` | `2` | рабочие процессы бэкенда; при заметной нагрузке — 4 |

Каждый процесс держит до 15 соединений с PostgreSQL: проверьте `max_connections`, если
поднимаете число процессов.

### Обновление

1. Сделайте резервную копию базы (см. ниже).
2. Распакуйте новую поставку и запустите установщик без параметров:
   ```bash
   sudo ./deploy/install.sh
   ```
   Он применит миграции, переключит `/opt/archmap/current` на новый релиз и перезапустит
   службу. Настройки и конфигурация nginx не трогаются.

**Откат.** Установщик печатает команду переключения на прежний релиз. Если новый релиз
уже изменил схему базы, сначала восстановите базу из резервной копии, затем переключите
релиз и перезапустите службу.

### Повседневное

- Состояние и журнал: `systemctl status archmap`, `journalctl -u archmap -f`.
- Проверка бэкенда: `curl -s http://127.0.0.1:8000/health` → `{"status":"ok"}`.
- Восстановить доступ администратору: `sudo archmap-admin create-admin <логин> --reset-password`
  (команда делает пользователя администратором, снимает блокировку и задаёт новый пароль).

### Если что-то не так

- **«Встроенный Python не запускается».** Каталог поставки смонтирован с `noexec`;
  на Astra Linux SE включена замкнутая программная среда — она запускает только
  подписанные программы; политика SELinux запрещает запуск (`ausearch -m avc`).
- **nginx отвечает 502.** Служба не работает: `journalctl -u archmap -n 50`. При включённом
  SELinux nginx нужно право обращаться к бэкенду — установщик выставляет
  `httpd_can_network_connect` сам.
- **Ввоз архива падает с 413.** Ограничение размера запроса: nginx от установщика принимает
  до 64 МБ; если перед ним стоит ещё один прокси, поднимите лимит и там.
- **«Слишком много попыток входа».** nginx пропускает 10 попыток входа в минуту с адреса.
  Если все пользователи приходят через один прокси (один адрес), поднимите `rate` в
  `/etc/nginx/conf.d/archmap.conf` и выполните `sudo systemctl reload nginx`.
- **Установщик остановился на проверке базы.** Сообщение называет, что поправить: версию,
  кодировку или права пользователя.

### Без nginx

`sudo ./deploy/install.sh --no-nginx` ставит только службу. Тогда ваш обратный прокси
должен отдавать файлы из `/opt/archmap/current/frontend` (для неизвестных путей —
`index.html`), проксировать `/api/` на `127.0.0.1:8000` и принимать запросы до 64 МБ.
Образец — конфигурация, которую установщик пишет для nginx (функция `render_nginx` в
`deploy/install.sh`).

### Публичный сервер: Let's Encrypt и демо-режим

Так поднят публичный стенд https://demo.archmap.tech. Сертификат Let's Encrypt выпускается
после первой установки по http, затем установщик запускается ещё раз уже с ним:

```bash
sudo ./deploy/install.sh --server-name demo.example.org
sudo certbot certonly --nginx -d demo.example.org --deploy-hook "systemctl reload nginx"
sudo ./deploy/install.sh --server-name demo.example.org \
  --tls-cert /etc/letsencrypt/live/demo.example.org/fullchain.pem \
  --tls-key /etc/letsencrypt/live/demo.example.org/privkey.pem
```

Сертификат продлевает `certbot.timer`, после продления nginx перечитывает его
(`--deploy-hook`). Первая установка по http записала в `CORS_ORIGINS` адрес с `http://` —
исправьте на `https://`.

Демо-режим — `DEMO_MODE=true` в `archmap.env`: вход только гостем, у каждого гостя своя
песочница с пределами, через сутки бездействия она удаляется. Процесс на демо один
(`ARCHMAP_WORKERS=1`): уборка песочниц и счётчик стартов с адреса живут внутри процесса —
с двумя процессами уборка шла бы наперегонки, а лимит стартов удвоился бы. Адрес гостя
бэкенд берёт из `X-Forwarded-For`: последний адрес в нём дописывает nginx, а uvicorn
доверяет только 127.0.0.1, так что подделать адрес клиент не может.

## Резервные копии

Всё состояние ArchMap — в базе, на диске приложение ничего не хранит.

```bash
pg_dump -Fc -h pg.example.local -U archmap archmap > archmap-$(date +%F).dump
pg_restore --clean --if-exists -h pg.example.local -U archmap -d archmap archmap-ГГГГ-ММ-ДД.dump
```

Отдельный проект можно выгрузить архивом из интерфейса — меню «Действия со схемой»
(три точки в шапке) → «Экспорт проекта (zip)» — и ввезти на другом экземпляре.

## Безопасность

- Регистрации нет (`ALLOW_SIGNUP=false`): учётки заводит администратор.
- Неудачные попытки входа ограничены: в OpenShift — самим приложением, на сервере — nginx.
- Swagger и описание API наружу не отдаются.
- В OpenShift под работает от произвольного UID без привилегий (SCC restricted-v2), корневая
  файловая система только для чтения, токен сервис-аккаунта в под не монтируется.
- На сервере служба работает от непривилегированного пользователя `archmap`, система для
  неё только для чтения.
- Без TLS пароли и токены идут открытым текстом — так можно только в доверенном тестовом сегменте.

## Ограничения

- Только x86_64.
- Вход через доменные учётные записи (AD/LDAP) пока не поддерживается.
- Документирование кода ИИ-агентом (BYOA, MCP-сервер из `mcp/`) работает с теми агентами,
  что разрешены в контуре; серверу ArchMap для этого ничего не нужно.
