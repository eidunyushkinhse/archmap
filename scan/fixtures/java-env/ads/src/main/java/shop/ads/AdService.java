package shop.ads;

import static shop.ads.Names.TRACE_FLAG;

import shop.ads.util.Env;

public final class AdService {
    private static final String STATS_FLAG = "DISABLE_STATS";

    public static void main(String[] args) {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "9555"));
        if (System.getenv(STATS_FLAG) != null) {
            return;
        }
        if (System.getenv(TRACE_FLAG) != null) {
            return;
        }
        String region = System.getenv().get(Env.REGION);
        String profile = System.getProperty("ads.profile");
        String dynamic = System.getenv(args[0]);
        String joined = System.getenv("ADS_" + profile);
        boolean enabled = System.getenv().containsKey("ADS_ENABLED");
        java.util.Map<String, String> all = System.getenv();
        // System.getenv("COMMENTED_FLAG")
    }
}
