"""привязка шага процесса к схеме логики (process_messages.doc_id)

Ф1 эпика «процессы → доки шага». Шаг получает адрес документации — id схемы
логики (node_docs). Именно id, а не строку операции: строка неоднозначна на живых
данных и не покрывает воркеров и клиентские сценарии (docs/plan-process-docs-step2.md).

ON DELETE SET NULL — тот же приём, что у edge_id: удаление схемы делает шаг
непривязанным, а не сносит его. Расхождение видно алертом полноты.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8d3f21a7c94e"
down_revision: str | Sequence[str] | None = "4c1e0a9f6b2d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("process_messages", sa.Column("doc_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_process_messages_doc_id",
        "process_messages",
        "node_docs",
        ["doc_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_process_messages_doc_id", "process_messages", type_="foreignkey")
    op.drop_column("process_messages", "doc_id")
