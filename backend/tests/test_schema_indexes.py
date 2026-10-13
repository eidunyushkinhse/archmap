"""У каждого внешнего ключа есть индекс (аудит 2026-10, M10/Q-1).

Postgres сам индекс под FK не создаёт: без него каскадное удаление узла сканирует
связанные таблицы целиком, а выборки детей и связей узла идут seq scan. SQLite в тестах
этого не покажет — сторожим по метаданным: колонка FK обязана быть первой в каком-то
индексе, первичном ключе или ограничении уникальности.
"""

from sqlalchemy import PrimaryKeyConstraint, UniqueConstraint

from app.database import Base


def test_каждый_внешний_ключ_под_индексом() -> None:
    missing = []
    for table in Base.metadata.tables.values():
        leading = {next(iter(ix.columns)).name for ix in table.indexes}
        leading |= {
            next(iter(c.columns)).name
            for c in table.constraints
            if isinstance(c, PrimaryKeyConstraint | UniqueConstraint) and c.columns
        }
        missing += [f"{table.name}.{fk.parent.name}" for fk in table.foreign_keys if fk.parent.name not in leading]
    assert missing == []
