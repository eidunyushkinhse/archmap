from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("store", "0002_rename")]

    operations = [
        migrations.CreateModel(
            name="Invoice",
            fields=[("id", models.AutoField(primary_key=True)), ("old", models.IntegerField())],
        ),
    ]
