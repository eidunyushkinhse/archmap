package org.example;

import org.example.a.Named;

@Path("/realms")
public class RealmsResource {
    static final String PREFIX = "/p";

    @GET
    public List<String> list() { return List.of(); }

    @Path("{realm}")
    public RealmResource realm(@PathParam("realm") String name) { return new RealmResource(); }

    @Path("{realm}/protocol/{protocol}")
    public Object protocol(@PathParam("protocol") String p) { return null; }

    @GET
    @Path("{version : v\\d[0-9a-z]*}")
    public String version() { return ""; }

    @GET
    @Path(PREFIX + "/x")
    public String dynamic() { return ""; }

    @Path("dup")
    public Dup dup() { return null; }

    @Path("named")
    public Named named() { return null; }

    // @GET в комментарии не маршрут
    @Path("missing")
    public NotHere missing() { return null; }
}
