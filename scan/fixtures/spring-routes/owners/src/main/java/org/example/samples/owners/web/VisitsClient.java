package org.example.samples.owners.web;

@FeignClient(name = "visits")
public interface VisitsClient {
    @GetMapping("/visits/{petId}")
    List<Visit> visits(@PathVariable int petId);
}
