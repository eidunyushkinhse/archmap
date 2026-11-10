package org.example;

public class UsersResource extends BaseResource {
    @GET
    @Path("{id:[0-9]+}")
    public String get(@PathParam("id") String id) { return ""; }

    @POST
    @Consumes("application/json")
    public void create(String body) { }

    @GET
    @Path("count")
    public int count() { return 0; }

    @GET
    @Path("count/{kind}")
    public int count(@PathParam("kind") String kind) { return 0; }

    @Override
    @GET
    @Path("find")
    public String search() { return ""; }
}
