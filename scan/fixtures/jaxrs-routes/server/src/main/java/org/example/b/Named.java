package org.example.b;

public class Named {
    @GET
    @Path("wrong")
    public String get() { return ""; }
}
