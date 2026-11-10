package items

/* Вложенный комментарий Kotlin: /* внутренний */ @GetMapping("/commented") ещё комментарий */
@RestController
@RequestMapping(value = ["/items", "/v2/items"])
class ItemController(private val repo: ItemRepository) {
    private val base = "/x"

    @GetMapping("/{id}")
    suspend fun find(@PathVariable id: String): Item? = repo.find(id)

    @PostMapping
    fun create(@RequestBody item: Item): Item {
        val note = """
            @GetMapping("/raw")
        """
        return item
    }

    @DeleteMapping("$base/{id}")
    fun remove(@PathVariable id: String) {}

    @RequestMapping(path = ["/bulk"], method = [RequestMethod.PUT, RequestMethod.PATCH])
    fun bulk() {}
}

data class Item(val id: String)
