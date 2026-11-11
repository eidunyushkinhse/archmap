from django.db import migrations

from . import helpers


class Migration(migrations.Migration):
    dependencies = [("core", "0002_state_and_database")]

    # Ловушка: список операций выражением, а не именем списка (awx _squashed.operations).
    operations = helpers.operations("x") + []
