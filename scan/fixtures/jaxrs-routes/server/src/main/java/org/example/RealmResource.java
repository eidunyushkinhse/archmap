package org.example;

@Path("ignored-on-subresource")
public class RealmResource {
    @GET
    public String get() { return ""; }

    @DELETE
    public void delete() { }

    @Path("users")
    public UsersResource users() { return new UsersResource(); }

    @Path("self")
    public RealmResource self() { return this; }
}
