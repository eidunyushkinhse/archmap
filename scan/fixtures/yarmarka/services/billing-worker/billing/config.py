import os

INVOICE_CURRENCY = os.environ.get("INVOICE_CURRENCY", "RUB")
RETRY_LIMIT = int(os.environ.get("RETRY_LIMIT", "5"))
