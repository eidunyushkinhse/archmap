package shop.jobs;

import java.util.concurrent.TimeUnit;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.annotation.Schedules;

public class Jobs {
    static final String NIGHTLY = "0 0 3 * * *";

    @Scheduled(cron = "0 0 * * * *")
    public void hourly() {
    }

    @Scheduled(fixedRate = 5000)
    public void ping() {
    }

    @Scheduled(fixedDelay = 30_000L, initialDelay = 1000)
    public void cleanup() {
    }

    @Scheduled(fixedRate = 10, timeUnit = TimeUnit.MINUTES)
    public void report() {
    }

    @Scheduled(fixedRateString = "${jobs.sync.rate:60000}")
    public void sync() {
    }

    @Scheduled(cron = "${jobs.export.cron}")
    public void export() {
    }

    @Scheduled(cron = NIGHTLY)
    public void nightly() {
    }

    @Scheduled(cron = Settings.cron())
    public void computed() {
    }

    @Schedules({
        @Scheduled(cron = "0 0 9 * * MON"),
        @Scheduled(cron = "0 0 9 * * FRI"),
    })
    public void twice() {
    }

    @Scheduled(cron = "-")
    public void off() {
    }

    @Scheduled(cron = "${jobs.maybe:-}")
    public void maybe() {
    }

    @Scheduled(initialDelay = 1000)
    public void once() {
    }

    // @Scheduled(cron = "0 0 1 * * *")
    public void commented() {
    }
}
