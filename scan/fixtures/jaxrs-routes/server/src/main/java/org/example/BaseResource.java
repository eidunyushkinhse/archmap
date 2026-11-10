package org.example;

public abstract class BaseResource {
    @OPTIONS
    public Response preflight() { return null; }

    @GET
    @Path("search")
    public String search() { return ""; }
}
