from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0001_initial")]

    operations = [
        # Таблица остаётся в базе, модель уходит из состояния (EarlyAccessFeature у PostHog).
        migrations.SeparateDatabaseAndState(database_operations=[], state_operations=[migrations.DeleteModel("Feature")]),
        # Поле в обоих списках: в базе то же изменение, что в состоянии, колонка одна.
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.AddField(model_name="token", name="value", field=models.CharField(max_length=64)),
                migrations.RunSQL("CREATE TABLE core_audit (id integer PRIMARY KEY, token_id integer REFERENCES core_token (id))"),
                migrations.RunPython(lambda apps, schema: None),
            ],
            state_operations=[
                migrations.AddField(model_name="token", name="value", field=models.CharField(max_length=64)),
            ],
        ),
        # Только database_operations (индекс у PostHog): идут в состояние, как раньше.
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.AddField(model_name="token", name="scope", field=models.TextField(null=True))],
        ),
    ]
