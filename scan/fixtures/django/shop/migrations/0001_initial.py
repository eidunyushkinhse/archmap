import django.contrib.postgres.fields
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("contenttypes", "0002_remove_content_type_name"),
    ]

    operations = [
        migrations.CreateModel(
            name="Customer",
            fields=[
                ("id", models.AutoField(primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=100)),
                ("tags", django.contrib.postgres.fields.ArrayField(
                    base_field=models.CharField(max_length=20), size=None)),
                ("owner", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name="Order",
            fields=[
                ("id", models.BigAutoField(primary_key=True, serialize=False)),
                ("customer", models.ForeignKey(
                    on_delete=django.db.models.deletion.PROTECT, to="store.customer")),
                ("total", models.DecimalField(decimal_places=2, max_digits=10)),
                ("note", models.TextField(null=True)),
                ("created", models.DateTimeField(auto_now_add=True)),
                ("parent", models.ForeignKey("self", null=True, on_delete=models.SET_NULL)),
                ("code", models.SlugField(db_column="order_code")),
            ],
            options={"ordering": ["-created"]},
        ),
        migrations.CreateModel(
            name="VipCustomer",
            fields=[],
            options={"proxy": True},
            bases=("store.customer",),
        ),
        migrations.CreateModel(
            name="Report",
            fields=[("id", models.AutoField(primary_key=True))],
            options={"managed": False, "db_table": "reports_view"},
        ),
        migrations.CreateModel(
            name="Legacy",
            fields=[("id", models.AutoField(primary_key=True))],
        ),
    ]
