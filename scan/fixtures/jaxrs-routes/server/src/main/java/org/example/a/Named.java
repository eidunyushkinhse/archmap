package org.example.a;

public class Named {
    @GET
    @Path("/{name}/")
    public String get() { return ""; }
}
