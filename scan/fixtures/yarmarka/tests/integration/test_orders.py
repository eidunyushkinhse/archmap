from fastapi import APIRouter

router = APIRouter(prefix="/test-only")


@router.get("/fake")
def fake():
    return {}
