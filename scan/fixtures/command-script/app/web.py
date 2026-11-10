from flask import Flask

web = Flask(__name__)


@web.route("/health")
def health():
    return "ok"
