from fastapi import FastAPI

app = FastAPI()


@app.get("/test-only")
def fake():
    return {}
