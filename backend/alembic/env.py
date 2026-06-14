from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

import app.models.business_process  # noqa: F401
import app.models.edge  # noqa: F401
import app.models.edge_waypoint  # noqa: F401
import app.models.ghost_edge_handle  # noqa: F401
import app.models.ghost_position  # noqa: F401
import app.models.node  # noqa: F401
import app.models.process_fragment  # noqa: F401
import app.models.process_message  # noqa: F401
import app.models.process_participant  # noqa: F401

# импортируем модели, чтобы Alembic видел их метаданные
import app.models.user  # noqa: F401
from alembic import context
from app.config import settings
from app.database import Base

config = context.config
config.set_main_option("sqlalchemy.url", settings.database_url)

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
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
