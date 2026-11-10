package org.example.vets;

import org.springframework.boot.context.properties.ConfigurationProperties;

// Record с вложенным record того же файла: vets.cache.ttl, vets.cache.heap-size.
@ConfigurationProperties(prefix = "vets")
public record VetsProperties(
    Cache cache,
    String title
) {
    public record Cache(
        int ttl,
        int heapSize
    ) {
    }
}
