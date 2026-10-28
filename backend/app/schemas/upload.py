"""Контракт загрузки файла с машины агента по одноразовой ссылке (app/uploads.py)."""

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, StringConstraints


class UploadCreate(BaseModel):
    # Имя файла, как его назовёт агент: им файл зовут замечания превью.
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=256)] = "input.yaml"


class UploadSlotOut(BaseModel):
    """Ссылка на загрузку: путь относительно адреса ArchMap, абсолютный адрес складывает
    инструмент MCP (он знает, по какому адресу агент пришёл). Ключ в пути показывается
    один раз."""

    id: uuid.UUID
    name: str
    path: str
    expires_at: datetime
    max_bytes: int


class UploadReceivedOut(BaseModel):
    """Ответ на приём файла — то, что агент сверяет с sha256sum у себя."""

    upload_id: uuid.UUID
    name: str
    size: int
    sha256: str


class UploadOut(BaseModel):
    """Принятый файл для инструментов MCP: текст целиком плюс размер и sha256."""

    id: uuid.UUID
    name: str
    size: int
    sha256: str
    content: str
