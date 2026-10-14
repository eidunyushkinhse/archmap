"""Общая нормализация текстов (app/text.py) и основание склейки (identity.basis_of_*).

Раньше это были дословные копии в импорте, синке и процессах (аудит Q-21) — тесты держат
единое поведение для всех потребителей.
"""

from app.identity import basis_of_key, basis_of_type
from app.text import identity_name, loose_name, sequence_text


def test_identity_name_регистр_и_пробелы() -> None:
    assert identity_name("  Сервис   Оплаты ") == identity_name("сервис оплаты") == "сервис оплаты"


def test_loose_name_без_разделителей() -> None:
    assert loose_name("Order-Service_v2.api") == loose_name("orderservicev2api") == "orderservicev2api"


def test_sequence_text_одна_строка_без_точки_с_запятой() -> None:
    assert sequence_text("создать;\n  заказ") == "создать, заказ"
    assert sequence_text(None) == sequence_text("") == ""


def test_основание_склейки() -> None:
    assert basis_of_key("git:github.com/org/x#api") == "code"
    assert basis_of_key("host:payments") == "dependency"
    assert basis_of_key("img:registry/x") == "name"  # снятый вид якоря
    assert basis_of_type(None) == "name"
