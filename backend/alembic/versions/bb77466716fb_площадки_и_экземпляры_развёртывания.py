"""площадки и экземпляры развёртывания

Revision ID: bb77466716fb
Revises: c6d6099cf80d
Create Date: 2026-10-22 18:12:12.633152

Ф0 эпика «схема развёртывания» (docs/tasks/deployment-view.md): площадки (облако,
кластер, ВМ, сервер) с вложенностью и экземпляры «объект стоит на площадке».
parent_id площадки — без каскада (NO ACTION; почему не RESTRICT — докстринг
модели): площадку с вложенными не удалить. Имя площадки
уникально в проекте (на неё ссылаются именем импорт и агент); пара (узел, площадка)
у экземпляра уникальна. Значений сред схема не хранит.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'bb77466716fb'
down_revision: Union[str, None] = 'c6d6099cf80d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('deployment_sites',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('parent_id', sa.Uuid(), nullable=True),
    sa.Column('name', sa.String(length=256), nullable=False),
    sa.Column('kind', sa.String(length=16), server_default='other', nullable=False),
    sa.Column('technology', sa.String(length=128), nullable=True),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('version', sa.Integer(), server_default='1', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['parent_id'], ['deployment_sites.id']),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('project_id', 'name', name='uq_deployment_sites_name')
    )
    op.create_index(op.f('ix_deployment_sites_parent_id'), 'deployment_sites', ['parent_id'], unique=False)
    op.create_index(op.f('ix_deployment_sites_project_id'), 'deployment_sites', ['project_id'], unique=False)
    op.create_table('deployment_instances',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('node_id', sa.Uuid(), nullable=False),
    sa.Column('site_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['node_id'], ['nodes.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['site_id'], ['deployment_sites.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('node_id', 'site_id', name='uq_deployment_instances_node_site')
    )
    op.create_index(op.f('ix_deployment_instances_node_id'), 'deployment_instances', ['node_id'], unique=False)
    op.create_index(op.f('ix_deployment_instances_project_id'), 'deployment_instances', ['project_id'], unique=False)
    op.create_index(op.f('ix_deployment_instances_site_id'), 'deployment_instances', ['site_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_deployment_instances_site_id'), table_name='deployment_instances')
    op.drop_index(op.f('ix_deployment_instances_project_id'), table_name='deployment_instances')
    op.drop_index(op.f('ix_deployment_instances_node_id'), table_name='deployment_instances')
    op.drop_table('deployment_instances')
    op.drop_index(op.f('ix_deployment_sites_project_id'), table_name='deployment_sites')
    op.drop_index(op.f('ix_deployment_sites_parent_id'), table_name='deployment_sites')
    op.drop_table('deployment_sites')
