package org.example.client;

@Path("/admin/realms")
public interface RealmsClient {
    @GET
    List<String> list();

    @Path("{realm}")
    RealmClient realm(@PathParam("realm") String realm);
}
