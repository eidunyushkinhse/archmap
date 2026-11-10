package shop.ad;

import java.util.Optional;

public final class AdService {
    public static void main(String[] args) {
        // Optional вокруг чтения окружения (как AdService.java OpenTelemetry Demo).
        int port =
            Integer.parseInt(
                Optional.ofNullable(System.getenv("AD_PORT"))
                    .orElseThrow(() -> new IllegalStateException("AD_PORT must not be null")));
        int prometheusPort =
            Integer.parseInt(Optional.ofNullable(System.getenv("AD_PROMETHEUS_PORT")).orElse("9465"));
        String host = Optional.ofNullable(System.getenv("AD_HOST")).orElseGet(() -> "ads");
        String other = Optional.ofNullable(System.getenv("AD_OTHER")).orElse(fallback());
        String trimmed = Optional.ofNullable(System.getenv("AD_TRIMMED")).map(String::trim).orElse("x");
        String qualified = java.util.Optional.ofNullable(System.getenv("AD_QUALIFIED")).orElse("q");
    }

    static String fallback() {
        return "f";
    }
}
