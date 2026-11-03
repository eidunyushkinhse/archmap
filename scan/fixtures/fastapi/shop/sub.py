from fastapi import FastAPI

subapp = FastAPI()


@subapp.get("/info")
def info():
    return {}
