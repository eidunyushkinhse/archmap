from django.db import migrations


class Migration(migrations.Migration):
    """Модели уходят из состояния этого приложения, таблицы остаются: platform.0001_initial
    создаёт их в своём состоянии с тем же db_table (как alerts → alerts_platform у PostHog)."""

    dependencies = [("alerts", "0001_initial"), ("platform", "0001_initial")]

    database_operations: list = []

    state_operations = [
        migrations.DeleteModel("AlertConfiguration"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(database_operations=database_operations, state_operations=state_operations)
    ]
