from flask import Blueprint

bp = Blueprint("shop", __name__, url_prefix="/shop")
api_bp = Blueprint("api", __name__, url_prefix="/api/v1")


@bp.get("/cart")
def cart():
    return "cart"


@bp.post("/cart/<int:item_id>")
def add(item_id):
    return "added"


@api_bp.route("/orders")
def orders():
    return "[]"
