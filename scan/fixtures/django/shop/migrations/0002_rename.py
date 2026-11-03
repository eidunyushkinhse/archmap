from django.db import migrations, models

from shop.operations import SafeDeleteModel


def fill(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [("store", "0001_initial")]

    operations = [
        migrations.RenameModel(old_name="Order", new_name="Purchase"),
        migrations.RenameField(model_name="customer", old_name="name", new_name="full_name"),
        migrations.RenameField(model_name="purchase", old_name="customer", new_name="buyer"),
        migrations.AddField(
            model_name="purchase",
            name="status",
            field=models.CharField(default="new", max_length=16),
        ),
        migrations.AlterField(model_name="purchase", name="note", field=models.TextField()),
        migrations.RemoveField(model_name="purchase", name="created"),
        migrations.AlterModelTable(name="customer", table="customers"),
        migrations.AddIndex(model_name="purchase", index=models.Index(fields=["status"])),
        migrations.RunPython(fill, migrations.RunPython.noop),
        SafeDeleteModel(name="Legacy"),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.AddField(
                    model_name="purchase", name="weight", field=models.FloatField(null=True)),
            ],
            state_operations=[migrations.RemoveField(model_name="purchase", name="total")],
        ),
        migrations.AlterOrderWithRespectTo(name="purchase", order_with_respect_to="buyer"),
        CustomOperation(),
    ]
