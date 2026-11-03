from django.db import migrations, models


class Migration(migrations.Migration):
    replaces = [("billing", "0001_initial"), ("billing", "0002_amount")]

    dependencies = [("store", "0002_rename")]

    operations = [
        migrations.CreateModel(
            name="Invoice",
            fields=[
                ("id", models.AutoField(primary_key=True)),
                ("amount", models.PositiveIntegerField()),
                ("purchase", models.OneToOneField(on_delete=models.CASCADE, to="store.purchase")),
                ("uploaded", models.FileField(upload_to="x")),
            ],
        ),
    ]
