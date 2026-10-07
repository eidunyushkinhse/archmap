from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool, text

import app.models.broker_channel  # noqa: F401
import app.models.business_process  # noqa: F401
import app.models.channel_field  # noqa: F401
import app.models.config_param  # noqa: F401
import app.models.db_column  # noqa: F401
import app.models.db_table  # noqa: F401
import app.models.edge  # noqa: F401
import app.models.node  # noqa: F401
import app.models.node_doc  # noqa: F401
import app.models.process_fragment  # noqa: F401
import app.models.process_message  # noqa: F401
import app.models.process_participant  # noqa: F401
import app.models.project  # noqa: F401
import app.models.project_member  # noqa: F401

# импортируем модели, чтобы Alembic видел их метаданные
import app.models.user  # noqa: F401
import app.models.view_layout  # noqa: F401
import app.models.view_state  # noqa: F401 — без импорта autogenerate предлагал DROP view_state
from alembic import context
from app.config import settings
from app.database import Base

config = context.config
# Опции Alembic проходят интерполяцию ConfigParser: «%» в URL (пароль со спецсимволами
# %-кодируется, например «$» → «%24») без удвоения роняет миграции «invalid
# interpolation syntax». Само приложение такой URL читает как есть.
config.set_main_option("sqlalchemy.url", settings.database_url.replace("%", "%%"))

# Ключ блокировки миграций. В OpenShift несколько подов стартуют разом, и каждый
# init-контейнер выполняет `alembic upgrade head`: блокировка ставит их в очередь,
# второй дождётся первого и найдёт схему уже на head.
MIGRATION_LOCK_KEY = 0x41524348  # «ARCH»

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            if connection.dialect.name == "postgresql":
                connection.execute(
                    text("SELECT pg_advisory_xact_lock(:key)"), {"key": MIGRATION_LOCK_KEY}
                )
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
