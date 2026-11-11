from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = []

    operations = [
        migrations.CreateModel(
            name="AlertConfiguration",
            fields=[("id", models.BigAutoField(primary_key=True)), ("name", models.CharField(max_length=40))],
        ),
        migrations.CreateModel(
            name="Thread",
            fields=[("id", models.BigAutoField(primary_key=True))],
        ),
    ]
