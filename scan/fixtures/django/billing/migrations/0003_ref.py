from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("billing", "0002_amount")]

    operations = [
        migrations.AddField(model_name="invoice", name="ref", field=models.UUIDField(null=True)),
    ]
