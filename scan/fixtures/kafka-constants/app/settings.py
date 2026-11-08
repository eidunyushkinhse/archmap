# Ловушка: модуль настроек без слова topics в имени файла реестром не становится.
import os

KAFKA_PREFIX = os.environ.get("KAFKA_PREFIX", "")
SUFFIX = os.getenv("KAFKA_SUFFIX", "")
