package org.example.client;

@RestController
public class ClientController {
    @GetMapping("/client")
    public String client() { return ""; }
}
