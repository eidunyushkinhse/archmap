"""Контракты демо-режима публичного стенда (docs/tasks/demo-mode.md)."""

from typing import Literal

from pydantic import BaseModel


class DemoLimits(BaseModel):
    """Пределы демо-стенда: фронт проверяет по ним файлы до загрузки и подписывает
    отказы. Объём текста и размер файла — в байтах."""

    nodes: int
    edges: int
    docs: int
    processes: int
    text_bytes: int
    file_bytes: int


class DemoExcess(BaseModel):
    """Превышение предела демо-проекта, которое дало бы применение импорта: что
    (объекты, связи, схемы логики, процессы, объём текста в байтах), сколько вышло и
    сколько можно. Есть только в демо-режиме и только при превышении; фронт по нему
    гасит кнопку применения и показывает полоску «142 из 100»."""

    kind: Literal["nodes", "edges", "docs", "processes", "text"]
    actual: int
    limit: int
