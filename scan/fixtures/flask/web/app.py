from flask import Flask

from web.views import api_bp, bp

app = Flask(__name__)
app.register_blueprint(bp)
# Префикс подключения заменяет свой префикс блюпринта, как у самого Flask.
app.register_blueprint(api_bp, url_prefix="/api/v2")


@app.route("/")
def index():
    return "ok"


@app.route("/login", methods=["GET", "POST"])
def login():
    return "login"


def legacy():
    return "old"


app.add_url_rule("/old", "legacy", legacy)
