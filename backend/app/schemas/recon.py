"""Pydantic-схемы разведки точек входа (Ф0 docs/plan-recon.md).

Пока только выдача промпта: приём перечня одним файлом (превью и применение) —
следующая фаза, и схемы под неё здесь заранее не заводятся.
"""

from pydantic import BaseModel


class ReconPromptOut(BaseModel):
    prompt: str
