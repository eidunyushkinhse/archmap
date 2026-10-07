// ГЕНЕРАТ scripts/landing-embed-scene.mjs — руками не править, перегенерировать скриптом.
// Снимок: «Маркетплейс «Ярмарка» v2», страница «Сервис заказов», позиции locals.
import type { LandingScene } from "./scene";

export const SCENE: LandingScene = {
  "source": {
    "project": "Маркетплейс «Ярмарка» v2",
    "focus": "Сервис заказов"
  },
  "graph": {
    "nodes": [
      {
        "id": "74131dcb-836d-497e-877b-12401a6e2585",
        "name": "API Gateway",
        "description": "Единая точка входа: маршрутизация к сервисам, проверка JWT, ограничение частоты запросов.",
        "role": "шлюз",
        "technology": "Kong",
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [
          {
            "id": "86e0846e-e046-4db2-820a-411e3fb109bd",
            "name": "Маршрутизация запроса",
            "kind": "operation",
            "operation": null,
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371798+03:00",
        "updated_at": "2026-08-19T10:12:17.371800+03:00"
      },
      {
        "id": "e106e5c5-cae2-48e6-9635-d167e723b4da",
        "name": "Kafka",
        "description": "Асинхронный обмен событиями между сервисами. Несёт события жизненного цикла заказа и изменения каталога.",
        "role": "шина событий",
        "technology": "Apache Kafka",
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "broker",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371801+03:00",
        "updated_at": "2026-08-19T10:12:17.371802+03:00"
      },
      {
        "id": "f02c675c-1da7-4e08-b8bb-7a512ad63299",
        "name": "Сервис заказов",
        "description": "Домен заказа: приём и хранение заказов, сага исполнения от оплаты до доставки.",
        "role": "сервис",
        "technology": null,
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 3,
        "has_children": true,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371805+03:00",
        "updated_at": "2026-08-19T10:12:17.371806+03:00"
      },
      {
        "id": "21349aeb-5697-436b-b217-7502d919168b",
        "name": "Сервис оплаты",
        "description": "Домен оплаты: счета, проведение платежей через внешний шлюз, антифрод-скоринг.",
        "role": "сервис",
        "technology": null,
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 3,
        "has_children": true,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371820+03:00",
        "updated_at": "2026-08-19T10:12:17.371821+03:00"
      }
    ],
    "edges": [
      {
        "id": "05c7fd60-4412-42e3-8a81-a82293c53c26",
        "label": "Статус оплаты заказа",
        "technology": "REST",
        "source_id": "74131dcb-836d-497e-877b-12401a6e2585",
        "target_id": "308bbd77-64a0-4315-a5ff-7492fb0b1f1a",
        "channel": null,
        "version": 1
      },
      {
        "id": "cde51e8b-2646-47b8-b253-2f4583ede3cd",
        "label": "События заказов для саги",
        "technology": "Kafka",
        "source_id": "e106e5c5-cae2-48e6-9635-d167e723b4da",
        "target_id": "8259621d-d755-4b39-82d4-33b92558a622",
        "channel": "orders.events",
        "version": 1
      },
      {
        "id": "b8d52953-a25e-4c60-bd9b-038bd2c81d2d",
        "label": "События жизненного цикла заказа",
        "technology": "Kafka",
        "source_id": "77f5a050-ca2b-4991-9f1f-a1b54783564a",
        "target_id": "e106e5c5-cae2-48e6-9635-d167e723b4da",
        "channel": "orders.events",
        "version": 1
      },
      {
        "id": "567daafd-cbc9-4827-b02e-3639b57ef7de",
        "label": "Хранение заказов",
        "technology": "SQL",
        "source_id": "77f5a050-ca2b-4991-9f1f-a1b54783564a",
        "target_id": "f665d127-739f-464a-b423-cc71ef051f24",
        "channel": null,
        "version": 1
      },
      {
        "id": "b3dacdc1-3437-439e-a9a6-18e3ba509a44",
        "label": "Событие «заказ оплачен»",
        "technology": "Kafka",
        "source_id": "308bbd77-64a0-4315-a5ff-7492fb0b1f1a",
        "target_id": "e106e5c5-cae2-48e6-9635-d167e723b4da",
        "channel": "orders.events",
        "version": 1
      },
      {
        "id": "fcd26d9a-0789-475a-ab04-26f8926d1c10",
        "label": "Выставление счёта",
        "technology": "REST",
        "source_id": "8259621d-d755-4b39-82d4-33b92558a622",
        "target_id": "308bbd77-64a0-4315-a5ff-7492fb0b1f1a",
        "channel": null,
        "version": 1
      },
      {
        "id": "4ebfd4af-0959-4c2c-93ea-6803fcbeddee",
        "label": "Журнал саги и статусы заказа",
        "technology": "SQL",
        "source_id": "8259621d-d755-4b39-82d4-33b92558a622",
        "target_id": "f665d127-739f-464a-b423-cc71ef051f24",
        "channel": null,
        "version": 1
      },
      {
        "id": "01373d04-2c73-4d4e-8bb0-ef7327c56d91",
        "label": "Создание отправления",
        "technology": "REST",
        "source_id": "8259621d-d755-4b39-82d4-33b92558a622",
        "target_id": "18067bc1-9bdf-4869-81e2-61b01a08fccd",
        "channel": null,
        "version": 1
      },
      {
        "id": "df86d0d7-37c4-4932-af01-d2003ecb19f3",
        "label": "Оформление и статусы заказов",
        "technology": "REST",
        "source_id": "74131dcb-836d-497e-877b-12401a6e2585",
        "target_id": "77f5a050-ca2b-4991-9f1f-a1b54783564a",
        "channel": null,
        "version": 3
      }
    ],
    "endpoints": [
      {
        "id": "18067bc1-9bdf-4869-81e2-61b01a08fccd",
        "name": "Служба доставки",
        "role": "внешний сервис",
        "technology": "REST API",
        "is_external": true,
        "shape": "service",
        "status": "existing",
        "node_depth": 0,
        "has_children": false,
        "child_count": 0,
        "ancestors": [],
        "is_ghost": true
      },
      {
        "id": "308bbd77-64a0-4315-a5ff-7492fb0b1f1a",
        "name": "Payment API",
        "role": "сервис",
        "technology": "Java/Spring",
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "node_depth": 2,
        "has_children": false,
        "child_count": 0,
        "ancestors": [
          {
            "id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
            "name": "Маркетплейс «Ярмарка»",
            "is_external": false
          },
          {
            "id": "21349aeb-5697-436b-b217-7502d919168b",
            "name": "Сервис оплаты",
            "is_external": false
          }
        ],
        "is_ghost": true
      },
      {
        "id": "77f5a050-ca2b-4991-9f1f-a1b54783564a",
        "name": "Order API",
        "role": "сервис",
        "technology": "Python/FastAPI",
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "node_depth": 2,
        "has_children": false,
        "child_count": 0,
        "ancestors": [
          {
            "id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
            "name": "Маркетплейс «Ярмарка»",
            "is_external": false
          },
          {
            "id": "f02c675c-1da7-4e08-b8bb-7a512ad63299",
            "name": "Сервис заказов",
            "is_external": false
          }
        ],
        "is_ghost": true
      },
      {
        "id": "8259621d-d755-4b39-82d4-33b92558a622",
        "name": "Оркестратор заказа",
        "role": "воркер (сага)",
        "technology": "Python",
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "node_depth": 2,
        "has_children": false,
        "child_count": 0,
        "ancestors": [
          {
            "id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
            "name": "Маркетплейс «Ярмарка»",
            "is_external": false
          },
          {
            "id": "f02c675c-1da7-4e08-b8bb-7a512ad63299",
            "name": "Сервис заказов",
            "is_external": false
          }
        ],
        "is_ghost": true
      },
      {
        "id": "f665d127-739f-464a-b423-cc71ef051f24",
        "name": "БД заказов",
        "role": "база данных",
        "technology": "PostgreSQL",
        "is_external": false,
        "shape": "database",
        "status": "existing",
        "node_depth": 2,
        "has_children": false,
        "child_count": 0,
        "ancestors": [
          {
            "id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
            "name": "Маркетплейс «Ярмарка»",
            "is_external": false
          },
          {
            "id": "f02c675c-1da7-4e08-b8bb-7a512ad63299",
            "name": "Сервис заказов",
            "is_external": false
          }
        ],
        "is_ghost": true
      }
    ],
    "layout": {
      "21349aeb-5697-436b-b217-7502d919168b": {
        "x": 304.75,
        "y": -111.33333333333334
      },
      "74131dcb-836d-497e-877b-12401a6e2585": {
        "x": 11,
        "y": 209.33333333333334
      },
      "e106e5c5-cae2-48e6-9635-d167e723b4da": {
        "x": 627.75,
        "y": -111.33333333333334
      },
      "f02c675c-1da7-4e08-b8bb-7a512ad63299": {
        "x": 399.45939902680755,
        "y": 128.11543910122472
      }
    },
    "version": 15,
    "graph_rev": 639,
    "meta_rev": 28,
    "has_status_info": true
  },
  "containerId": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
  "layoutViewId": "f02c675c-1da7-4e08-b8bb-7a512ad63299",
  "ancestors": [
    {
      "id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
      "name": "Маркетплейс «Ярмарка»",
      "is_external": false
    }
  ],
  "children": {
    "183c04a6-b1e1-4dc9-b776-895e202dc1fe": [
      {
        "id": "74131dcb-836d-497e-877b-12401a6e2585",
        "name": "API Gateway",
        "description": "Единая точка входа: маршрутизация к сервисам, проверка JWT, ограничение частоты запросов.",
        "role": "шлюз",
        "technology": "Kong",
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [
          {
            "id": "86e0846e-e046-4db2-820a-411e3fb109bd",
            "name": "Маршрутизация запроса",
            "kind": "operation",
            "operation": null,
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371798+03:00",
        "updated_at": "2026-08-19T10:12:17.371800+03:00"
      },
      {
        "id": "e106e5c5-cae2-48e6-9635-d167e723b4da",
        "name": "Kafka",
        "description": "Асинхронный обмен событиями между сервисами. Несёт события жизненного цикла заказа и изменения каталога.",
        "role": "шина событий",
        "technology": "Apache Kafka",
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "broker",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371801+03:00",
        "updated_at": "2026-08-19T10:12:17.371802+03:00"
      },
      {
        "id": "a5693d91-6490-4cf1-98e2-29c39ebf393f",
        "name": "Веб-витрина",
        "description": "Витрина маркетплейса в браузере: каталог, корзина, оформление заказа, кабинет продавца.",
        "role": "SPA",
        "technology": "React",
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [
          {
            "id": "7f52dc64-6c38-4e60-b646-5367378b9f9a",
            "name": "Кабинет продавца: публикация товара",
            "kind": "operation",
            "operation": null,
            "version": 1,
            "described": true
          },
          {
            "id": "f7a49c7d-ab5e-4b46-a1ba-c057a0e05f39",
            "name": "Оформление заказа на витрине",
            "kind": "operation",
            "operation": null,
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/storefront-web",
        "source": {
          "repo": "github.com/yarmarka/storefront-web",
          "path": null,
          "host": null
        },
        "version": 4,
        "created_at": "2026-08-19T10:12:17.371803+03:00",
        "updated_at": "2026-08-19T18:11:05.892976+03:00"
      },
      {
        "id": "e3eed0e0-8408-400c-9a04-5dd7df4afa06",
        "name": "Мобильное приложение",
        "description": "Мобильный клиент покупателя. Ходит в тот же API Gateway, что и веб-витрина.",
        "role": "клиент",
        "technology": "iOS/Android",
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/mobile-app",
        "source": {
          "repo": "github.com/yarmarka/mobile-app",
          "path": null,
          "host": null
        },
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371804+03:00",
        "updated_at": "2026-08-19T10:12:17.371805+03:00"
      },
      {
        "id": "f02c675c-1da7-4e08-b8bb-7a512ad63299",
        "name": "Сервис заказов",
        "description": "Домен заказа: приём и хранение заказов, сага исполнения от оплаты до доставки.",
        "role": "сервис",
        "technology": null,
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 3,
        "has_children": true,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371805+03:00",
        "updated_at": "2026-08-19T10:12:17.371806+03:00"
      },
      {
        "id": "21349aeb-5697-436b-b217-7502d919168b",
        "name": "Сервис оплаты",
        "description": "Домен оплаты: счета, проведение платежей через внешний шлюз, антифрод-скоринг.",
        "role": "сервис",
        "technology": null,
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 3,
        "has_children": true,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371820+03:00",
        "updated_at": "2026-08-19T10:12:17.371821+03:00"
      },
      {
        "id": "f3fc0c75-b6c0-4031-b31e-c851df2e0824",
        "name": "Сервис поиска",
        "description": "Домен поиска: полнотекстовый индекс товаров и API поисковых запросов.",
        "role": "сервис",
        "technology": null,
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 2,
        "has_children": true,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371826+03:00",
        "updated_at": "2026-08-19T10:12:17.371827+03:00"
      },
      {
        "id": "655edb32-9345-400f-9fa0-d458184e8c0f",
        "name": "Сервис пользователей",
        "description": "Домен пользователя: учётные записи, вход и токены, профиль и адреса доставки.",
        "role": "сервис",
        "technology": null,
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 3,
        "has_children": true,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371831+03:00",
        "updated_at": "2026-08-19T10:12:17.371832+03:00"
      },
      {
        "id": "3a07990c-ba79-418c-9869-f00b5dc69d69",
        "name": "Сервис уведомлений",
        "description": "Домен уведомлений: шаблоны, журнал отправки, доставка писем и SMS через внешнего провайдера.",
        "role": "сервис",
        "technology": null,
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 3,
        "has_children": true,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371837+03:00",
        "updated_at": "2026-08-19T10:12:17.371838+03:00"
      },
      {
        "id": "870d3977-92ca-4a0e-8e94-ea49ab03ab23",
        "name": "Сервис рекомендаций",
        "description": "Планируемый сервис персональных подборок на главной. Пока отдаёт популярные товары, ML-ранжирование — в планах.",
        "role": "сервис",
        "technology": "Python",
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "service",
        "status": "planned",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 5,
        "created_at": "2026-08-19T10:12:17.371842+03:00",
        "updated_at": "2026-08-19T18:15:00.490713+03:00"
      },
      {
        "id": "2cd96e90-0c87-49c0-829b-e299739080ca",
        "name": "Сервис каталога",
        "description": "Домен товара: карточки, категории, кэш и поток событий изменений для поискового индекса.",
        "role": "сервис",
        "technology": null,
        "parent_id": "183c04a6-b1e1-4dc9-b776-895e202dc1fe",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 4,
        "has_children": true,
        "source_ref": null,
        "source": null,
        "version": 13,
        "created_at": "2026-08-19T10:12:17.371813+03:00",
        "updated_at": "2026-09-04T22:05:39.818046+03:00"
      }
    ],
    "f02c675c-1da7-4e08-b8bb-7a512ad63299": [
      {
        "id": "f665d127-739f-464a-b423-cc71ef051f24",
        "name": "БД заказов",
        "description": "Заказы, их позиции и журнал саги исполнения.",
        "role": "база данных",
        "technology": "PostgreSQL",
        "parent_id": "f02c675c-1da7-4e08-b8bb-7a512ad63299",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "database",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371808+03:00",
        "updated_at": "2026-08-19T10:12:17.371809+03:00"
      },
      {
        "id": "8259621d-d755-4b39-82d4-33b92558a622",
        "name": "Оркестратор заказа",
        "description": "Ведёт сагу заказа по событиям: выставляет счёт после создания, создаёт отправление после оплаты, ретраит упавшие шаги.",
        "role": "воркер (сага)",
        "technology": "Python",
        "parent_id": "f02c675c-1da7-4e08-b8bb-7a512ad63299",
        "openapi_spec": null,
        "docs": [
          {
            "id": "6f83ef18-7ef8-4914-805d-abb308ea4f0c",
            "name": "Сага заказа",
            "kind": "worker",
            "operation": null,
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/orders#services/order-saga",
        "source": {
          "repo": "github.com/yarmarka/orders",
          "path": "services/order-saga",
          "host": null
        },
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371810+03:00",
        "updated_at": "2026-08-19T10:12:17.371812+03:00"
      },
      {
        "id": "77f5a050-ca2b-4991-9f1f-a1b54783564a",
        "name": "Order API",
        "description": "Принимает и хранит заказы, отдаёт их состав и статус, публикует события жизненного цикла заказа.",
        "role": "сервис",
        "technology": "Python/FastAPI",
        "parent_id": "f02c675c-1da7-4e08-b8bb-7a512ad63299",
        "openapi_spec": null,
        "docs": [
          {
            "id": "50f564a9-54f0-40f1-aee5-5efcd696ac32",
            "name": "Автоотмена неоплаченных заказов",
            "kind": "worker",
            "operation": null,
            "version": 1,
            "described": true
          },
          {
            "id": "f3e20157-0e54-448d-8ebb-b85db859002c",
            "name": "Получение заказа",
            "kind": "operation",
            "operation": "GET /orders/{order_id}",
            "version": 1,
            "described": true
          },
          {
            "id": "cbe5d124-0b83-4b78-8906-1737f44a121a",
            "name": "Создание заказа",
            "kind": "operation",
            "operation": "POST /orders",
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/orders#services/order-api",
        "source": {
          "repo": "github.com/yarmarka/orders",
          "path": "services/order-api",
          "host": null
        },
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371807+03:00",
        "updated_at": "2026-08-19T10:12:17.815805+03:00"
      }
    ],
    "21349aeb-5697-436b-b217-7502d919168b": [
      {
        "id": "308bbd77-64a0-4315-a5ff-7492fb0b1f1a",
        "name": "Payment API",
        "description": "Выставляет счета, проводит платежи через ЮKassa, принимает вебхуки статуса, хранит платежи и вердикты антифрода.",
        "role": "сервис",
        "technology": "Java/Spring",
        "parent_id": "21349aeb-5697-436b-b217-7502d919168b",
        "openapi_spec": null,
        "docs": [
          {
            "id": "a3a6e263-3ec5-4fb8-9af7-ccd6709b72ce",
            "name": "Вебхук статуса платежа",
            "kind": "operation",
            "operation": "POST /payments/webhook",
            "version": 1,
            "described": true
          },
          {
            "id": "d8227e12-810d-4701-a69b-4ae8c34280a9",
            "name": "Выставление счёта",
            "kind": "operation",
            "operation": "POST /payments",
            "version": 1,
            "described": true
          },
          {
            "id": "811d9bb1-4b01-494a-9127-5fb02eeec63c",
            "name": "Статус платежа",
            "kind": "operation",
            "operation": "GET /payments/{payment_id}",
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/payments#services/payment-api",
        "source": {
          "repo": "github.com/yarmarka/payments",
          "path": "services/payment-api",
          "host": null
        },
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371822+03:00",
        "updated_at": "2026-08-19T10:12:17.815803+03:00"
      },
      {
        "id": "03dc6466-0864-44a2-8300-f7cf824ed29b",
        "name": "БД платежей",
        "description": "Платежи и результаты антифрод-проверок.",
        "role": "база данных",
        "technology": "PostgreSQL",
        "parent_id": "21349aeb-5697-436b-b217-7502d919168b",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "database",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371825+03:00",
        "updated_at": "2026-08-19T10:12:17.371825+03:00"
      },
      {
        "id": "69f49bcf-2ff1-41eb-90b7-99749e7a11e3",
        "name": "Антифрод",
        "description": "Скоринг транзакций по правилам и ML-модели. Без своего состояния — правила и модель приезжают конфигурацией.",
        "role": "сервис",
        "technology": "Python",
        "parent_id": "21349aeb-5697-436b-b217-7502d919168b",
        "openapi_spec": null,
        "docs": [
          {
            "id": "261c8320-8a36-48d1-822a-cfd6eb6dd7b6",
            "name": "Скоринг транзакции",
            "kind": "operation",
            "operation": null,
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 2,
        "created_at": "2026-08-19T10:12:17.371823+03:00",
        "updated_at": "2026-09-29T17:41:52.878652+03:00"
      }
    ],
    "f3fc0c75-b6c0-4031-b31e-c851df2e0824": [
      {
        "id": "80ea24b4-4f20-419c-9654-2867a99e7633",
        "name": "Elasticsearch",
        "description": "Полнотекстовый индекс карточек товаров. Наполняется индексатором, читается Search API.",
        "role": "поисковый индекс",
        "technology": "Elasticsearch",
        "parent_id": "f3fc0c75-b6c0-4031-b31e-c851df2e0824",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "database",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371828+03:00",
        "updated_at": "2026-08-19T10:12:17.371828+03:00"
      },
      {
        "id": "853ffbaa-9420-4ecd-a017-acdec0044c4d",
        "name": "Search API",
        "description": "Поиск товаров по индексу с фильтрами и ранжированием.",
        "role": "сервис",
        "technology": "Go",
        "parent_id": "f3fc0c75-b6c0-4031-b31e-c851df2e0824",
        "openapi_spec": null,
        "docs": [
          {
            "id": "32653290-41ba-4b2a-a5bf-8c68c1571ad6",
            "name": "Поиск товаров",
            "kind": "operation",
            "operation": "GET /search",
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/search#services/search-api",
        "source": {
          "repo": "github.com/yarmarka/search",
          "path": "services/search-api",
          "host": null
        },
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371829+03:00",
        "updated_at": "2026-08-19T10:12:17.815805+03:00"
      }
    ],
    "655edb32-9345-400f-9fa0-d458184e8c0f": [
      {
        "id": "05f016da-dca8-4808-9f86-25e9b208d71d",
        "name": "Auth API",
        "description": "Регистрация, вход, выпуск и обновление JWT, обслуживание refresh-токенов.",
        "role": "сервис",
        "technology": "Python/FastAPI",
        "parent_id": "655edb32-9345-400f-9fa0-d458184e8c0f",
        "openapi_spec": null,
        "docs": [
          {
            "id": "4c16e7cd-f34f-48d1-85a5-5129ea94da56",
            "name": "Вход",
            "kind": "operation",
            "operation": "POST /auth/login",
            "version": 1,
            "described": true
          },
          {
            "id": "9a3c61cc-c943-4a71-a046-db0e3093b098",
            "name": "Обновление токена",
            "kind": "operation",
            "operation": "POST /auth/refresh",
            "version": 1,
            "described": true
          },
          {
            "id": "0045388f-ee50-4456-bd54-c71af865a44c",
            "name": "Очистка истёкших токенов",
            "kind": "worker",
            "operation": null,
            "version": 1,
            "described": true
          },
          {
            "id": "656c9351-7831-413a-8805-5d5943d39a12",
            "name": "Регистрация",
            "kind": "operation",
            "operation": "POST /auth/register",
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/users#services/auth-api",
        "source": {
          "repo": "github.com/yarmarka/users",
          "path": "services/auth-api",
          "host": null
        },
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371832+03:00",
        "updated_at": "2026-08-19T10:12:17.815799+03:00"
      },
      {
        "id": "1f1280ce-5a93-4160-a465-80545c5c79ef",
        "name": "БД пользователей",
        "description": "Учётные записи, refresh-токены и адреса доставки.",
        "role": "база данных",
        "technology": "PostgreSQL",
        "parent_id": "655edb32-9345-400f-9fa0-d458184e8c0f",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "database",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371835+03:00",
        "updated_at": "2026-08-19T10:12:17.371836+03:00"
      },
      {
        "id": "b7e7c7e9-7bfd-4c9b-80ea-3fd1969e4ed3",
        "name": "Profile API",
        "description": "Профиль покупателя и адреса доставки.",
        "role": "сервис",
        "technology": "Python/FastAPI",
        "parent_id": "655edb32-9345-400f-9fa0-d458184e8c0f",
        "openapi_spec": null,
        "docs": [
          {
            "id": "ebfe55a8-5c59-4177-a2ae-c27e03ff7eda",
            "name": "Адреса доставки",
            "kind": "operation",
            "operation": "PUT /profile/addresses",
            "version": 1,
            "described": true
          },
          {
            "id": "8d586fd7-1beb-4c28-83e0-61c7db32173a",
            "name": "Профиль покупателя",
            "kind": "operation",
            "operation": "GET /profile",
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/users#services/profile-api",
        "source": {
          "repo": "github.com/yarmarka/users",
          "path": "services/profile-api",
          "host": null
        },
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371834+03:00",
        "updated_at": "2026-08-19T10:12:17.815806+03:00"
      }
    ],
    "3a07990c-ba79-418c-9869-f00b5dc69d69": [
      {
        "id": "2d9ab998-c104-4f23-9f58-5b107f693130",
        "name": "Notification worker",
        "description": "Слушает события заказов, собирает письма по шаблонам и отправляет их через провайдера рассылок.",
        "role": "воркер",
        "technology": "Python",
        "parent_id": "3a07990c-ba79-418c-9869-f00b5dc69d69",
        "openapi_spec": null,
        "docs": [
          {
            "id": "34ddc553-1e0d-4aac-a437-981da4723ca5",
            "name": "Отправка уведомлений",
            "kind": "worker",
            "operation": null,
            "version": 1,
            "described": true
          },
          {
            "id": "12052e18-8397-4714-a70b-95457de8a16c",
            "name": "Повторная отправка",
            "kind": "worker",
            "operation": null,
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/notifications#services/notification-worker",
        "source": {
          "repo": "github.com/yarmarka/notifications",
          "path": "services/notification-worker",
          "host": null
        },
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371839+03:00",
        "updated_at": "2026-08-19T10:12:17.371840+03:00"
      },
      {
        "id": "5c4fd8af-c664-4158-9eaa-8ebb18830532",
        "name": "БД уведомлений",
        "description": "Шаблоны сообщений и журнал отправленных уведомлений.",
        "role": "база данных",
        "technology": "PostgreSQL",
        "parent_id": "3a07990c-ba79-418c-9869-f00b5dc69d69",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "database",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371841+03:00",
        "updated_at": "2026-08-19T10:12:17.371841+03:00"
      },
      {
        "id": "dcee936e-0d1e-4331-8c58-dd3d808a099a",
        "name": "SMS-рассыльщик",
        "description": "Legacy-путь отправки SMS: раз в интервал вычитывает из журнала уведомления, которым SMS не ушла, и шлёт их напрямую через провайдера рассылок. Выводится — отправку SMS перенял Notification worker (параметр SMS_ENABLED); воркер удалят, когда на журнале не останется старых записей.",
        "role": "воркер",
        "technology": "Python",
        "parent_id": "3a07990c-ba79-418c-9869-f00b5dc69d69",
        "openapi_spec": null,
        "docs": [
          {
            "id": "42c8e34c-ab79-4ef2-8442-cb80864ffc84",
            "name": "Разбор очереди SMS",
            "kind": "worker",
            "operation": null,
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "deprecated",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/notifications#services/sms-sender",
        "source": {
          "repo": "github.com/yarmarka/notifications",
          "path": "services/sms-sender",
          "host": null
        },
        "version": 1,
        "created_at": "2026-09-14T14:19:22.186733+03:00",
        "updated_at": "2026-09-14T14:19:22.186738+03:00"
      }
    ],
    "2cd96e90-0c87-49c0-829b-e299739080ca": [
      {
        "id": "46d7c732-d85e-4e4f-b3d5-cf2a3a277b14",
        "name": "БД каталога",
        "description": "Товары, категории и их привязки.",
        "role": "база данных",
        "technology": "PostgreSQL",
        "parent_id": "2cd96e90-0c87-49c0-829b-e299739080ca",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "database",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371816+03:00",
        "updated_at": "2026-08-19T10:12:17.371817+03:00"
      },
      {
        "id": "bc0a0cd7-ccb6-481b-b20f-b0aefc00cf8b",
        "name": "Индексатор товаров",
        "description": "Слушает события изменения товаров и пакетно обновляет поисковый индекс.",
        "role": "воркер",
        "technology": "Python",
        "parent_id": "2cd96e90-0c87-49c0-829b-e299739080ca",
        "openapi_spec": null,
        "docs": [
          {
            "id": "ff8322b6-f4eb-4d9c-8000-490bc529d0db",
            "name": "Индексация товаров",
            "kind": "worker",
            "operation": null,
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/catalog#services/product-indexer",
        "source": {
          "repo": "github.com/yarmarka/catalog",
          "path": "services/product-indexer",
          "host": null
        },
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371817+03:00",
        "updated_at": "2026-08-19T10:12:17.371818+03:00"
      },
      {
        "id": "348b5a94-7171-4fd0-942a-e26e40a10d59",
        "name": "Кэш каталога",
        "description": "Кэш собранных карточек товара. Сбрасывается при изменении товара.",
        "role": "кэш",
        "technology": "Redis",
        "parent_id": "2cd96e90-0c87-49c0-829b-e299739080ca",
        "openapi_spec": null,
        "docs": [],
        "is_external": false,
        "shape": "database",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": null,
        "source": null,
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371819+03:00",
        "updated_at": "2026-08-19T10:12:17.371819+03:00"
      },
      {
        "id": "744cf8ab-7916-47cb-936d-f70000468dcf",
        "name": "Catalog API",
        "description": "Карточки товаров и категории. Пишет изменения в БД, кэширует карточки, публикует события изменений.",
        "role": "сервис",
        "technology": "Python/FastAPI",
        "parent_id": "2cd96e90-0c87-49c0-829b-e299739080ca",
        "openapi_spec": null,
        "docs": [
          {
            "id": "662bc544-bf94-44f8-bfe0-73243fcc1402",
            "name": "Изменение товара",
            "kind": "operation",
            "operation": "PATCH /products/{product_id}",
            "version": 1,
            "described": true
          },
          {
            "id": "69dc9d4c-a62f-4d58-a5e6-f4e10892d409",
            "name": "Карточка товара",
            "kind": "operation",
            "operation": "GET /products/{product_id}",
            "version": 1,
            "described": true
          },
          {
            "id": "cbe455f2-8498-4807-b7df-196061eb76ef",
            "name": "Публикация товара",
            "kind": "operation",
            "operation": "POST /products",
            "version": 1,
            "described": true
          }
        ],
        "is_external": false,
        "shape": "service",
        "status": "existing",
        "child_count": 0,
        "has_children": false,
        "source_ref": "git:github.com/yarmarka/catalog#services/catalog-api",
        "source": {
          "repo": "github.com/yarmarka/catalog",
          "path": "services/catalog-api",
          "host": null
        },
        "version": 1,
        "created_at": "2026-08-19T10:12:17.371814+03:00",
        "updated_at": "2026-08-19T10:12:17.815804+03:00"
      }
    ]
  }
};
