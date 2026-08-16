"""Сторож декларации копирования проекта (app/copy_plan.py).

Копия проекта трижды отставала от модели — и каждый раз узнавал об этом пользователь.
Эти тесты и есть тот гейт, который обязан узнавать первым: новая колонка модели или
новая модель, не попавшая в декларацию, роняет их с указанием, что именно решить.
"""

import importlib
import pkgutil

import pytest
from sqlalchemy import inspect as sa_inspect

import app.models
from app.copy_plan import COPY_PLAN, NOT_COPIED, copy_row
from app.database import Base
from app.models.node import Node


def _all_mapped_models() -> set[type]:
    """Все модели проекта. Пакет обходим ФАЙЛАМИ, а не списком импортов: новая модель
    приезжает отдельным модулем, и сторож обязан увидеть её сам, без правки списка."""
    for module in pkgutil.iter_modules(app.models.__path__):
        importlib.import_module(f"app.models.{module.name}")
    return {mapper.class_ for mapper in Base.registry.mappers}


def test_plan_declares_every_column_of_copied_models():
    """Каждая колонка копируемой модели классифицирована: данные / своё / пересчёт."""
    for model, plan in COPY_PLAN.items():
        columns = {attr.key for attr in sa_inspect(model).column_attrs}
        declared = set(plan.own) | set(plan.mapped) | set(plan.data)
        assert columns == declared, (
            f"{model.__name__}: декларация разошлась с моделью. "
            f"Не объявлено (новое поле?): {sorted(columns - declared)}; "
            f"объявлено, но в модели нет: {sorted(declared - columns)}. "
            "Решите про поле: data (едет в копию как есть), own (у копии своё) или "
            "mapped (значение пересчитывает копировщик)."
        )


def test_every_model_is_classified_as_copied_or_not():
    """Новая модель обязана попасть либо в COPY_PLAN, либо в NOT_COPIED с причиной.

    Именно этот пропуск стоил пользователю структуры БД и каналов брокеров: таблицы
    завели, а в копировании о них не вспомнили — и никто не споткнулся.
    """
    unclassified = _all_mapped_models() - set(COPY_PLAN) - set(NOT_COPIED)
    assert not unclassified, (
        "Модели не объявлены в app/copy_plan.py: "
        f"{sorted(m.__name__ for m in unclassified)}. Решите, копирует их копия "
        "проекта (COPY_PLAN) или намеренно нет (NOT_COPIED, с причиной)."
    )


def test_plan_categories_do_not_overlap_and_reasons_are_written():
    """Колонка ровно в одной категории, у own/mapped — причина словами (исключение
    обязано быть осознанным)."""
    for model, plan in COPY_PLAN.items():
        own, mapped, data = set(plan.own), set(plan.mapped), set(plan.data)
        assert not (own & mapped), f"{model.__name__}: {sorted(own & mapped)} и own, и mapped"
        assert not (own & data), f"{model.__name__}: {sorted(own & data)} и own, и data"
        assert not (mapped & data), f"{model.__name__}: {sorted(mapped & data)} и mapped, и data"
        for column, reason in {**plan.own, **plan.mapped}.items():
            assert reason.strip(), f"{model.__name__}.{column}: исключение без причины"
    for model, reason in NOT_COPIED.items():
        assert reason.strip(), f"{model.__name__}: не копируется без объяснения причины"


def test_copy_row_copies_data_columns_by_default():
    """Дефолт — КОПИРОВАТЬ: копировщик берёт колонку из модели, а не из списка полей."""
    import uuid

    src = Node(id=uuid.uuid4(), project_id=uuid.uuid4(), name="Платежи", status="planned")
    new_project = uuid.uuid4()
    copy = copy_row(src, id=uuid.uuid4(), project_id=new_project, parent_id=None)
    assert (copy.name, copy.status) == ("Платежи", "planned")
    assert copy.project_id == new_project and copy.id != src.id


def test_copy_row_rejects_override_of_undeclared_column():
    """Подмена колонки, не объявленной ни own, ни mapped, — расхождение плана с
    копировщиком: молчать о нём нельзя."""
    import uuid

    src = Node(id=uuid.uuid4(), project_id=uuid.uuid4(), name="Платежи")
    with pytest.raises(ValueError, match="не объявлена"):
        copy_row(src, id=uuid.uuid4(), project_id=uuid.uuid4(), name="Другое имя")
