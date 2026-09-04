"""якорь — образ и k8s вне идентичности

Revision ID: d84f05694ac7
Revises: fed34b60cbc8
Create Date: 2026-09-04 19:23:56.669308

Миграция ДАННЫХ, схему не трогает (docs/plan-anchor-ux.md, Ф0).

Зачем: якорь узла сузился до двух видов — код (git:repo#path) и имя зависимости
(host:name). Образ контейнера (img:) и объект Kubernetes (k8s:) описывают КОНТУР
РАЗВЁРТЫВАНИЯ, а не продукт, и якорями больше не считаются. Оставленный в
nodes.source_ref ключ снятого вида ни с чем не сравнивался бы (его типа нет в
KEY_ORDER), но продолжал бы показываться в карточке объекта и уезжать в экспорт —
мусор, выглядящий как рабочая примета.

Сколько записей: в живой БД на 2026-09-04 — 1 строка с img: (узел «renderer»
проекта «Zabbix+Grafana R2»), k8s: — ни одной.

Потеря данных осознанная: узел без якоря опознаётся по имени внутри своего
контейнера — ровно так же, как всякий узел, созданный руками.
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'd84f05694ac7'
down_revision: Union[str, None] = 'fed34b60cbc8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "UPDATE nodes SET source_ref = NULL "
        "WHERE source_ref LIKE 'img:%' OR source_ref LIKE 'k8s:%'"
    )


def downgrade() -> None:
    # Обратного хода нет намеренно: значения снятых видов якоря не сохраняются,
    # восстанавливать нечего. Откат кода вернёт поддержку img:/k8s: в сравнении,
    # но не сами ключи — их придётся заново привезти прогоном агента.
    pass
