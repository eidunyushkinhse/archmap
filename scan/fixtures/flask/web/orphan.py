from flask import Blueprint

orphan = Blueprint("orphan", __name__, url_prefix="/orphan")


@orphan.route("/x")
def x():
    return "x"
