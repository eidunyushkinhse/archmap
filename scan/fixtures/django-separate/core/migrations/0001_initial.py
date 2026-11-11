from django.db import migrations, models

OPERATIONS = [
    migrations.CreateModel(
        name="Feature",
        fields=[("id", models.AutoField(primary_key=True))],
    ),
    migrations.CreateModel(
        name="Token",
        fields=[("id", models.AutoField(primary_key=True))],
    ),
]


class Migration(migrations.Migration):
    dependencies = []

    operations = OPERATIONS
