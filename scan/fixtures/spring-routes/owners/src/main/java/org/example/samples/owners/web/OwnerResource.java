package org.example.samples.owners.web;

import org.springframework.web.bind.annotation.*;

@RequestMapping("/owners")
@RestController
class OwnerResource {
    static final String BY_ID = "/{ownerId}";

    @PostMapping
    public Owner create(@RequestBody Owner owner) { return owner; }

    @GetMapping(value = BY_ID)
    public Owner find(@PathVariable int ownerId) { return null; }

    @GetMapping
    public List<Owner> findAll() { return List.of(); }

    @PutMapping(path = {"/{ownerId}", "/{ownerId:[0-9]+}/edit"})
    public void update(@PathVariable int ownerId) { }

    // @DeleteMapping("/commented") в комментарии не маршрут
    @DeleteMapping(value = "/" + "x")
    public void remove() { String s = "@GetMapping(\"/in-string\")"; }

    @Override
    @RequestMapping(value = "/fallback", method = { RequestMethod.GET, RequestMethod.POST })
    public String fallback() { return "x"; }

    @RequestMapping("any")
    public String any() { return "x"; }

    static class Helper {
        @GetMapping("/helper")
        void helper() { }
    }
}
