from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool, text

import app.models.broker_channel
import app.models.business_process
import app.models.channel_field
import app.models.config_param
import app.models.db_column
import app.models.db_table
import app.models.edge
import app.models.node
import app.models.node_doc
import app.models.node_version
import app.models.personal_token
import app.models.process_fragment
import app.models.process_message
import app.models.process_participant
import app.models.project
import app.models.project_member

# импортируем модели, чтобы Alembic видел их метаданные
import app.models.user
import app.models.view_layout
import app.models.view_state  # noqa: F401 — без импорта autogenerate предлагал DROP view_state
from alembic import context
from app.config import settings
from app.database import Base

config = context.config
# Опции Alembic проходят интерполяцию ConfigParser: «%» в URL (пароль со спецсимволами
# %-кодируется, например «$» → «%24») без удвоения роняет миграции «invalid
# interpolation syntax». Само приложение такой URL читает как есть.
config.set_main_option("sqlalchemy.url", settings.database_url.replace("%", "%%"))

# Ключ блокировки миграций. В Kubernetes несколько подов стартуют разом, и каждый
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
