from fastapi import FastAPI

app = FastAPI()


@app.get("/docs-example")
def example():
    return {}
