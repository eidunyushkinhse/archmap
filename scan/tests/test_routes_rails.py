"""Маршруты Rails (ТЗ §15 п. 15 К1): config/routes.rb и config/routes/*.rb по маске Ruby.
Глаголы, match с via:, root, resources и resource с only: и except:, member и collection,
вложенные ресурсы, namespace, scope, constraints, concern, draw; ловушки: глагол в
комментарии, строке, heredoc и теле def, mount, путь с подстановкой, draw без файла."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import codetext, registry, stats, texts
from archmap_scan.model import Findings
from archmap_scan.parsers import rails_routes
from tests.helpers import FIXTURES, files_of, model_of, tree

GEMFILE = 'gem "rails"\n'


def _routes(root: Path) -> list[tuple[str, str, bool, str]]:
    ctx, files = files_of(root)
    found = rails_routes.parse(files, ctx)
    return sorted((r.method, r.path, r.prefix_unresolved, str(r.loc)) for r in found.routes)


def test_fixture() -> None:
    devise = "config/routes.rb:58"
    assert _routes(FIXTURES / "rails-routes") == [
        ("ANY", "/*unmatched", False, "config/routes.rb:16"),
        # devise_for :users, path: 'auth' (П6): registerable — DELETE /auth.
        ("DELETE", "/auth", False, devise),
        ("DELETE", "/auth/sign_out", False, devise),
        # shallow: true у posts: члены вложенного comments от корня (П6).
        ("DELETE", "/comments/:id", False, "config/routes.rb:32"),
        ("GET", "/", False, "config/routes.rb:11"),
        ("GET", "/.well-known/webfinger", False, "config/routes.rb:41"),
        ("GET", "/admin/reports", False, "config/routes.rb:37"),
        # draw(:api) читает файл на месте вызова, namespace складываются.
        ("GET", "/api/v1/instance", False, "config/routes/api.rb:6"),
        ("GET", "/api/v1/statuses", False, "config/routes/api.rb:5"),
        ("GET", "/api/v1/statuses/:id", False, "config/routes/api.rb:5"),
        # scope "(/locale/:locale)" и 'archive(/:page)': основная форма без групп (П6).
        ("GET", "/archive", False, "config/routes.rb:54"),
        ("GET", "/auth/cancel", False, devise),
        ("GET", "/auth/edit", False, devise),
        # path_names: { sign_in: 'login' } подменяет сегмент.
        ("GET", "/auth/login", False, devise),
        ("GET", "/auth/password/edit", False, devise),
        ("GET", "/auth/password/new", False, devise),
        ("GET", "/auth/sign_up", False, devise),
        ("GET", "/comments/:id", False, "config/routes.rb:32"),
        ("GET", "/comments/:id/edit", False, "config/routes.rb:32"),
        # Файл config/routes/, который никто не подключил, читается от корня.
        ("GET", "/extra", False, "config/routes/extra.rb:3"),
        ("GET", "/feed", False, "config/routes.rb:45"),
        # get 'health' в scope с группой совпал с записанным: одна запись, строка 13.
        ("GET", "/health", False, "config/routes.rb:13"),
        # devise_scope прозрачен.
        ("GET", "/join", False, "config/routes.rb:61"),
        # resources с except: шесть операций (PUT не пишется, это дубль PATCH).
        ("GET", "/posts", False, "config/routes.rb:26"),
        ("GET", "/posts/:id", False, "config/routes.rb:26"),
        ("GET", "/posts/:id/edit", False, "config/routes.rb:26"),
        # member do … end и on: :member — путь члена ресурса.
        ("GET", "/posts/:id/preview", False, "config/routes.rb:28"),
        ("GET", "/posts/:id/stats", False, "config/routes.rb:31"),
        # Вложенный ресурс под /posts/:post_id, как у самой Rails: index, new и create и у
        # неглубокого под родителем.
        ("GET", "/posts/:post_id/comments", False, "config/routes.rb:32"),
        ("GET", "/posts/:post_id/comments/new", False, "config/routes.rb:32"),
        # Тело concern читается там, где его подключили, основание — строка в concern.
        ("GET", "/posts/:post_id/likes", False, "config/routes.rb:22"),
        ("GET", "/posts/new", False, "config/routes.rb:26"),
        ("GET", "/profile", False, "config/routes.rb:34"),
        ("GET", "/userinfo", False, "config/routes.rb:15"),
        # resources :users, only: [:show] — одна запись.
        ("GET", "/users/:id", False, "config/routes.rb:25"),
        ("PATCH", "/auth", False, devise),
        ("PATCH", "/auth/password", False, devise),
        ("PATCH", "/comments/:id", False, "config/routes.rb:32"),
        ("PATCH", "/posts/:id", False, "config/routes.rb:26"),
        ("PATCH", "/profile", False, "config/routes.rb:34"),
        ("POST", "/auth", False, devise),
        ("POST", "/auth/login", False, devise),
        ("POST", "/auth/password", False, devise),
        ("POST", "/login", False, "config/routes.rb:14"),
        ("POST", "/posts", False, "config/routes.rb:26"),
        ("POST", "/posts/:post_id/comments", False, "config/routes.rb:32"),
        # collection { post :batch } — блок в фигурных скобках.
        ("POST", "/posts/batch", False, "config/routes.rb:30"),
        ("POST", "/userinfo", False, "config/routes.rb:15"),
    ]


def test_fixture_hints() -> None:
    """mount даёт подсказку, а не маршрут; путь с подстановкой #{…} — подсказка о
    динамическом пути. Глагол в комментарии, строке, heredoc и теле def не читается,
    draw(:legacy) без файла не падает. devise (П6): модуль invitable без известного набора
    маршрутов и devise_for :admins без модели — подсказки на строке devise_for; validatable
    маршрутов не даёт."""
    ctx, files = files_of(FIXTURES / "rails-routes")
    found = rails_routes.parse(files, ctx)
    assert [(h.section, h.data["name"], h.data["reason"], h.data["source"]) for h in found.hints] == [
        ("dynamic_names", "\"/#{ENV.fetch('PREFIX', 'x')}/dynamic\"",
         texts.REASON_DYNAMIC_ROUTE, "config/routes.rb:17"),
        ("unassigned", "Sidekiq::Web /sidekiq", texts.REASON_RAILS_MOUNT, "config/routes.rb:19"),
        ("unassigned", "invitable", texts.REASON_DEVISE_MODULE, "config/routes.rb:58"),
        ("unassigned", "admins", texts.REASON_DEVISE_MODEL, "config/routes.rb:59"),
    ]
    paths = {r.path for r in found.routes}
    for trap in ("/commented", "/in-string", "/in-heredoc", "/legacy"):
        assert not any(trap in p for p in paths)
    assert not any(p.startswith("/from-helper") for p in paths)


def test_owner_is_web_server() -> None:
    """Маршруты Rails у контейнера, чья команда запускает веб-сервер (puma); контейнер с
    sidekiq в команде маршрутов не получает. Подсказка mount в счёт «без владельца» не
    входит, семья покрыта без «Ruby» в unsupported."""
    model = model_of(FIXTURES / "rails-routes")
    assert sorted(model.http) == ["web"]
    assert len(model.http["web"]) == 48
    assert {e.framework for e in model.http["web"]} == {"Rails"}
    stacks = stats.code_unsupported(_findings(FIXTURES / "rails-routes"))
    assert "Ruby" not in stacks.get("http_routes", [])
    assert "Ruby: Rails" not in stacks.get("http_routes", [])


def _findings(root: Path) -> Findings:
    ctx, files = files_of(root)
    found, errors = registry.collect(files, ctx)
    assert errors == {}
    return found


def test_rails_server_command(tmp_path: Path) -> None:
    """«rails server» в команде — веб-сервер: маршруты у него, а не у контейнера с
    «bundle exec rails» без server (у Forem rails и web из одного каталога)."""
    tree(tmp_path, {
        "Gemfile": GEMFILE,
        "docker-compose.yml": "services:\n  rails:\n    build: .\n    command: bundle exec rails\n"
        "  web:\n    build: .\n    command: bundle exec rails server -b 0.0.0.0\n",
        "config/routes.rb": "Rails.application.routes.draw do\n  get '/a', to: 'a#b'\nend\n",
    })
    model = model_of(tmp_path)
    assert {k: [e.path for e in v] for k, v in model.http.items()} == {"web": ["/a"]}


def test_without_rails_not_read(tmp_path: Path) -> None:
    """Gemfile без rails не читается; Sinatra назван в непрочитанных маршрутах (ТЗ §15 п. 15
    К3, vocab.UNSUPPORTED_ROUTE_DEPS)."""
    tree(tmp_path, {
        "Gemfile": 'gem "sinatra"\n',
        "config/routes.rb": "get '/a'\n",
    })
    ctx, files = files_of(tmp_path)
    found = rails_routes.parse(files, ctx)
    assert found.routes == [] and rails_routes.NAME not in found.applied
    collected, _ = registry.collect(files, ctx)
    assert stats.code_unsupported(collected)["http_routes"] == ["Ruby: Sinatra"]


def test_scopes_and_options(tmp_path: Path) -> None:
    """scope со строкой и символом, scope module: без префикса, path: и param: у ресурса,
    вложенный под param, match без via:, iterator с путём из переменной — подсказка."""
    tree(tmp_path, {
        "Gemfile": GEMFILE,
        "config/routes.rb": (
            "Rails.application.routes.draw do\n"
            "  scope '(:locale)' do\n"
            "    get 'about'\n"
            "  end\n"
            "  scope :v2, module: :v2 do\n"
            "    resources :accounts, path: 'users', param: :username, only: %i[show] do\n"
            "      resources :statuses, only: :show\n"
            "    end\n"
            "  end\n"
            "  scope module: :x do\n"
            "    match 'any', to: 'a#b'\n"
            "  end\n"
            "  %w(/a /b).each { |path| get path, to: 'home#index' }\n"
            "  resources :things, only: SOME_ACTIONS\n"
            "end\n"
        ),
    })
    assert _routes(tmp_path) == [
        ("ANY", "/any", False, "config/routes.rb:11"),
        # scope '(:locale)': необязательная группа не пишется (П6).
        ("GET", "/about", False, "config/routes.rb:3"),
        ("GET", "/v2/users/:account_username/statuses/:id", False, "config/routes.rb:7"),
        ("GET", "/v2/users/:username", False, "config/routes.rb:6"),
    ]
    ctx, files = files_of(tmp_path)
    hints = rails_routes.parse(files, ctx).hints
    assert [(h.data["name"], h.data["source"]) for h in hints] == [
        ("path", "config/routes.rb:13"), ("SOME_ACTIONS", "config/routes.rb:14"),
    ]


def test_optional_groups() -> None:
    """Необязательные группы (П6): вложенные снимаются целиком, «//» схлопываются,
    незакрытая скобка оставляет путь как есть."""
    strip = rails_routes._strip_groups
    assert strip("(/locale/:locale)") == ("", True)
    assert strip("posts(/:page)") == ("posts", True)
    assert strip("a/(b(/c))/d") == ("a/d", True)
    assert strip("/@:user/(*any)") == ("/@:user/", True)
    assert strip("a(b") == ("a(b", False)
    assert strip("plain") == ("plain", False)


def test_devise_options(tmp_path: Path) -> None:
    """devise_for (П6): модули в нескольких вызовах devise модели, префикс namespace,
    skip:, only:, sign_out_via:, path_names с «=>», omniauthable, lockable и confirmable."""
    tree(tmp_path, {
        "Gemfile": GEMFILE,
        "app/models/user.rb": (
            "class User\n  devise :two_factor_authenticatable,\n         otp_secret_length: 32\n"
            "  devise :confirmable, :lockable, :omniauthable, :registerable\n"
            "  # devise :recoverable\nend\n"
        ),
        "app/models/account.rb": "class Account\n  devise :database_authenticatable, :recoverable\nend\n",
        "config/routes.rb": (
            "Rails.application.routes.draw do\n"
            "  namespace :admin do\n"
            "    devise_for :users, skip: [:registrations, :unlocks], sign_out_via: [:get, :delete],\n"
            "               :path_names => { :sign_out => 'logout' }\n"
            "  end\n"
            "  devise_for :accounts, only: :passwords, controllers: { passwords: 'p' }, format: false\n"
            "end\n"
        ),
    })
    at = "config/routes.rb"
    assert _routes(tmp_path) == [
        ("DELETE", "/admin/users/logout", False, f"{at}:3"),
        ("GET", "/accounts/password/edit", False, f"{at}:6"),
        ("GET", "/accounts/password/new", False, f"{at}:6"),
        ("GET", "/admin/users/auth/:provider", False, f"{at}:3"),
        ("GET", "/admin/users/auth/:provider/callback", False, f"{at}:3"),
        ("GET", "/admin/users/confirmation", False, f"{at}:3"),
        ("GET", "/admin/users/confirmation/new", False, f"{at}:3"),
        ("GET", "/admin/users/logout", False, f"{at}:3"),
        ("GET", "/admin/users/sign_in", False, f"{at}:3"),
        ("PATCH", "/accounts/password", False, f"{at}:6"),
        ("POST", "/accounts/password", False, f"{at}:6"),
        ("POST", "/admin/users/auth/:provider", False, f"{at}:3"),
        ("POST", "/admin/users/auth/:provider/callback", False, f"{at}:3"),
        ("POST", "/admin/users/confirmation", False, f"{at}:3"),
        ("POST", "/admin/users/sign_in", False, f"{at}:3"),
    ]


def test_shallow_block(tmp_path: Path) -> None:
    """Блок shallow do … end (П6): вложенный ресурс неглубокий, члены от префикса namespace;
    его вложенные — под неглубоким членом. Ресурс вне блока как раньше."""
    tree(tmp_path, {
        "Gemfile": GEMFILE,
        "config/routes.rb": (
            "Rails.application.routes.draw do\n"
            "  namespace :api do\n"
            "    shallow do\n"
            "      resources :boards, only: :show do\n"
            "        resources :cards, only: [:index, :show] do\n"
            "          resources :notes, only: [:create, :destroy]\n"
            "        end\n"
            "      end\n"
            "    end\n"
            "    resources :teams, only: [] do\n"
            "      resources :members, only: :show\n"
            "    end\n"
            "  end\n"
            "end\n"
        ),
    })
    at = "config/routes.rb"
    assert _routes(tmp_path) == [
        ("DELETE", "/api/notes/:id", False, f"{at}:6"),
        ("GET", "/api/boards/:board_id/cards", False, f"{at}:5"),
        ("GET", "/api/boards/:id", False, f"{at}:4"),
        ("GET", "/api/cards/:id", False, f"{at}:5"),
        ("GET", "/api/teams/:team_id/members/:id", False, f"{at}:11"),
        ("POST", "/api/cards/:card_id/notes", False, f"{at}:6"),
    ]


def test_devise_model_hostile(tmp_path: Path) -> None:
    """Враждебная модель devise на 2 МБ: число вызовов, строк вызова и символов ограничено,
    разбор в пределе времени с запасом 30 %."""
    from functools import partial

    from tests.helpers import time_limit, timed

    routes = "Rails.application.routes.draw do\n  devise_for :users\nend\n"
    for body in (
        "devise :a,\n" * 180_000,
        "devise " + "".join(f":m{i}, " for i in range(200_000)) + "\n",
        "devise\n" * 250_000,
    ):
        tree(tmp_path, {"Gemfile": GEMFILE, "config/routes.rb": routes, "app/models/user.rb": body})
        ctx, files = files_of(tmp_path)
        _found, took = timed(partial(rails_routes.parse, files, ctx), time_limit())
        assert took < time_limit() * 0.7, f"{took:.2f} с"


def test_limits(tmp_path: Path) -> None:
    """Больше 5000 записей в файле или 50 вложенных блоков — набор маршрутов не пишется,
    файл непрочитан."""
    tree(tmp_path, {
        "Gemfile": GEMFILE,
        "config/routes.rb": "resources :a\n" * 800,
        "deep/config/routes.rb": "scope 'x' do\n" * 60 + "get 'y'\n" + "end\n" * 60,
    })
    ctx, files = files_of(tmp_path)
    found = rails_routes.parse(files, ctx)
    assert found.routes == []
    assert files.too_large == {"config/routes.rb", "deep/config/routes.rb"}


def test_ruby_mask() -> None:
    """Маска Ruby: комментарии, строки, литералы %w и %r, heredoc и регулярное выражение —
    пробелы, длина и переводы строк те же."""
    text = (
        "get 'a#b' # get '/c'\n"
        "x = %w[get /d]\n"
        "y = %r{[^/]+{2}}\n"
        "z = <<~SQL, 1\n"
        "  get '/e'\n"
        "SQL\n"
        "c = { id: /'\\d+/ }\n"
        "=begin\nget '/f'\n=end\n"
        "get 'g'\n"
    )
    mask = codetext.mask(text, codetext.RUBY)
    assert len(mask) == len(text) and mask.count("\n") == text.count("\n")
    lines = mask.split("\n")
    assert lines[0].rstrip() == "get '   '"
    assert lines[1] == "x = %w[      ]"
    assert lines[2] == "y = %r{        }"
    assert lines[3] == "z = <<~SQL, 1"
    assert lines[4].strip() == "" and lines[5].strip() == ""
    assert lines[6] == "c = { id: /    / }"
    assert "get" not in "".join(lines[7:10])
    assert lines[10] == "get ' '"
