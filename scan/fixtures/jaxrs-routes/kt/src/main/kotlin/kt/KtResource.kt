package kt

@Path("/kt")
class KtResource {
    @GET
    @Path("/hello")
    fun hello(): String = "hi"

    @Path("sub")
    fun sub(): SubResource = SubResource()
}

class SubResource {
    @PUT
    fun put(body: String) {}
}
