package org.example.samples.owners.web;

@RestController
public class PetResource {

    @GetMapping("/petTypes")
    public List<PetType> getPetTypes() { return List.of(); }

    @GetMapping("owners/*/pets/{petId}")
    public Pet findPet(@PathVariable("petId") int petId) { return null; }

    @GetMapping(produces = "application/json")
    public String root() { return ""; }
}
