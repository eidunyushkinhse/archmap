from fastapi import APIRouter

router = APIRouter()


@router.put("/{item_id}")
def update(item_id: int):
    return {"id": item_id}
