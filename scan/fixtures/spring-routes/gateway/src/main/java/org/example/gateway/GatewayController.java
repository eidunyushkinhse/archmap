package org.example.gateway;

@RestController
@RequestMapping(value = "/api/gateway", method = RequestMethod.GET)
public class GatewayController {
    @RequestMapping("owners/{ownerId}")
    public Mono<Owner> owner(@PathVariable int ownerId) { return null; }

    @GetMapping(path = Paths.PETS)
    public Mono<Pet> pets() { return null; }

    @PostMapping(pathFor("x"))
    public void dynamic() { }
}
