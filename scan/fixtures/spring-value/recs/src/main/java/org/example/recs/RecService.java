package org.example.recs;

import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;

public class RecService {
    // Параметр конструктора с дефолтом: тип по типу параметра.
    public RecService(
        Object other,
        @Value("${recommendation.catalog-timeout-ms:2000}") long catalogTimeoutMillis,
        @Value("${recommendation.mode}") final String mode) {
    }

    @Value("${shop.name}")
    private String name;

    @org.springframework.beans.factory.annotation.Value("${shop.ratio:0.5}")
    private double ratio;

    @Value("#{systemProperties['user.region']}")
    private String spel;

    @Value("literal")
    private String plain;

    @Value("${a.first}/${a.second:2}")
    private String joined;

    @Value("${outer.key:${inner.key:5}}")
    private int nested;

    @Value("${" + "dyn}")
    private String dynamic;

    @Value(Keys.KEY)
    private String constant;

    @Value("${shop.timeout:PT5S}")
    public void setTimeout(Duration timeout) {
    }

    @Value("${shop.flags:a,b}")
    private String[] flags;
}

@lombok.Value
class Immutable {
    String x;
}
