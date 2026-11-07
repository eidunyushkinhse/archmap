# Ловушка: словарь «…_TO_TOPICS» сопоставляет темам вебхуков типы объектов, его ключи не темы.
OBJECT_TYPE_TO_TOPICS: dict[str, tuple[str, ...]] = {
    "post": ("post.created", "post.updated"),
    "comment": ("comment.created",),
}
