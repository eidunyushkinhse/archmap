package org.example.vets;

import java.time.Duration;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.context.annotation.Bean;

// Класс со свойствами: поля с сеттерами, вложенный класс на один уровень.
@ConfigurationProperties("shop.mail")
public class MailProperties {
    private String sender = "shop";
    private int port = 25;
    private Duration timeout = Duration.ofSeconds(5);
    private boolean enabled;
    private List<String> recipients;
    private static final String IGNORED = "x";
    private String noSetter = "x";
    private Retry retry = new Retry();
    private long maxSizeBytes = 1_000L;

    public void setSender(String sender) { this.sender = sender; }
    public void setPort(int port) { this.port = port; }
    public void setTimeout(Duration timeout) { this.timeout = timeout; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public void setRecipients(List<String> recipients) { this.recipients = recipients; }
    public void setRetry(Retry retry) { this.retry = retry; }
    public void setMaxSizeBytes(long v) { this.maxSizeBytes = v; }
    public String getNoSetter() { return noSetter; }
    public abstract static class Base { abstract void hook(); }

    public static class Retry {
        private int attempts = 3;
        private Deep deep;
        public void setAttempts(int attempts) { this.attempts = attempts; }
        public void setDeep(Deep deep) { this.deep = deep; }
    }

    public static class Deep {
        private int level = 1;
        public void setLevel(int level) { this.level = level; }
    }
}

@lombok.Data
@ConfigurationProperties(prefix = Names.PREFIX)
class LombokProperties {
    private String name = "n";
    private static int counter;
}

@ConfigurationProperties("rec")
record RecProperties(@DefaultValue("7") int size, String label) {
}

@ConfigurationProperties(prefix = "a" + "b")
class JoinedProperties {
    private int x;
    public void setX(int x) { this.x = x; }
}

class Config {
    @Bean
    @ConfigurationProperties("bean.made")
    MailProperties mail() { return new MailProperties(); }
}
