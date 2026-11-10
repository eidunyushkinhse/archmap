package org.example;

@RestController
public class TestController {
    @GetMapping("/testsuite-only")
    public String t() { return ""; }
}
