from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [("auth", "0012_alter_user_first_name_max_length")]

    operations = [
        migrations.CreateModel(
            name="User",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ("email", models.EmailField(unique=True)),
                ("groups", models.ManyToManyField(to="auth.group")),
            ],
        ),
    ]
