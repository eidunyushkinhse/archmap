"""Подсказка «похоже на …» к битому имени или пути — одна и только уверенная.

Пороги и правило «мелкого расхождения» общие у дозаливки доков, каналов и импорта
YAML (аудит Q-22: импорт держал их дословной копией).
"""

from collections.abc import Iterable
from difflib import SequenceMatcher

from app.text import loose_name

# Порог похожести для подсказки «похоже на …». НИЖЕ НЕ ОПУСКАТЬ: ложная подсказка
# хуже её отсутствия — слабая модель копирует предложенное имя не глядя, и вместо
# битой пометки получается пометка, битая по-другому. Полевая валидация Ф8 показала
# это буквально: по подсказкам-мусору модель «починила» три пометки в СЕМАНТИЧЕСКИ
# ДРУГИЕ таблицы, а сильные подсказки того же круга исполнила верно.
HINT_CUTOFF = 0.75
# Суффиксным матчем короткие хвосты не проверяем: «id» есть в конце половины имён.
HINT_MIN_TAIL = 3
# Сколько символов ВСЕГО (на обе строки) может не совпасть у «того же имени, записанного
# иначе». Одной похожести мало: у таблиц одного приложения общий длинный префикс, и
# difflib даёт «sentry_projectoptions» ↔ «sentry_projectcodeowners» целых 0.79 при
# девяти несовпавших символах — это РАЗНЫЕ таблицы. У настоящих же кандидатов расхождение
# АБСОЛЮТНО мелкое: разделитель, окончание, опечатка (0–3 символа).
HINT_MAX_DIFF = 3
# Разделители, которыми одно и то же имя пишут по-разному: «...member_teams» против
# «...memberteam», «task-worker» против «taskworker».


def tiny_diff(m: SequenceMatcher[str], a: str, b: str) -> float | None:
    """Похожесть a и b (сравнитель m уже настроен на них), если они расходятся ТОЛЬКО
    мелочью, иначе None. Сравнитель снаружи — чтобы горячий цикл подсказок импорта
    YAML мог переиспользовать его (set_seq1/set_seq2) и отсеивать быстрыми оценками.

    Два условия, и второе главное: похожесть выше порога И абсолютное расхождение не
    больше HINT_MAX_DIFF символов. Порога одного недостаточно — соседи по префиксу
    приложения набирают 0.75+ на общем начале, ничего общего не имея по смыслу.
    """
    ratio = m.ratio()
    if ratio < HINT_CUTOFF:
        return None
    matched = sum(block.size for block in m.get_matching_blocks())
    if (len(a) - matched) + (len(b) - matched) > HINT_MAX_DIFF:
        return None
    return ratio


def closest_name(tail: str, names: Iterable[str]) -> str | None:
    """Ближайшее описанное имя к хвосту битой ссылки — или None.

    Сначала СУФФИКС: «messages» → «app_message». Разрыв «имя ORM-класса против имени
    таблицы» почти всегда состоит из префикса приложения и числа (находка №1
    docs/qa-zulip-brokers.md), а difflib на нём слабеет тем сильнее, чем длиннее
    префикс: «queues» против «background_jobs_queue» — 0.37, ниже порога. Сравниваем
    имена БЕЗ РАЗДЕЛИТЕЛЕЙ, иначе «user_profile» не узнаёт себя в «zerver_userprofile».

    difflib идёт добором и только на мелких расхождениях (tiny_diff): опечатка,
    окончание, разделитель. Подсказка ОДНА и только уверенная — не нашли уверенного
    кандидата, замечание остаётся как было.
    """
    by_low: dict[str, str] = {}
    for name in names:
        if name != tail:  # точное совпадение чинить нечем — там дело не в имени
            by_low.setdefault(name.lower(), name)
    if not by_low:
        return None
    norm = loose_name(tail)
    # Единственное и множественное: агент пишет имя таблицы во множественном
    # («messages»), а в DDL она в единственном («app_message»), и наоборот.
    variants = [
        v for v in (norm, norm[:-1] if norm.endswith("s") else "") if len(v) >= HINT_MIN_TAIL
    ]
    hits = [
        orig for cand, orig in by_low.items() if any(loose_name(cand).endswith(v) for v in variants)
    ]
    if hits:
        return min(hits, key=lambda n: (-SequenceMatcher(None, norm, loose_name(n)).ratio(), n))
    by_norm: dict[str, str] = {}
    for cand, orig in by_low.items():
        by_norm.setdefault(loose_name(cand), orig)
    best: tuple[float, str] | None = None
    for cand in sorted(by_norm):  # порядок каталога произволен — выбор должен быть один
        ratio = tiny_diff(SequenceMatcher(None, norm, cand), norm, cand)
        if ratio is not None and (best is None or ratio > best[0]):
            best = (ratio, cand)
    return by_norm[best[1]] if best is not None else None
