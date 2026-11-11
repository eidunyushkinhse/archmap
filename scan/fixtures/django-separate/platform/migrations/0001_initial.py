from django.db import migrations, models

database_operations = []

state_operations = [
    migrations.CreateModel(
        name="PlatformAlertConfiguration",
        fields=[("id", models.BigAutoField(primary_key=True)), ("name", models.CharField(max_length=40))],
        options={"db_table": "alerts_alertconfiguration"},
    ),
    migrations.CreateModel(
        name="DeliveryPath",
        fields=[
            ("id", models.BigAutoField(primary_key=True)),
            ("configuration", models.ForeignKey(on_delete=models.CASCADE, to="platform.platformalertconfiguration")),
        ],
    ),
]


class Migration(migrations.Migration):
    dependencies = [("alerts", "0001_initial")]

    operations = [
        migrations.SeparateDatabaseAndState(database_operations=database_operations, state_operations=state_operations)
    ]
