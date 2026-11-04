from starlette.applications import Starlette
from starlette.routing import Mount, Route


def homepage(request):
    return None


routes = [
    Route("/", homepage),
    Mount("/api", routes=[Route("/users", homepage, methods=["GET", "POST"])]),
]
app = Starlette(routes=routes)
