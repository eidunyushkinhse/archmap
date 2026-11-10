package shop;

import java.util.*;

public class Orders {
    static final String REFUNDS = "refunds";
    String audit = Optional.ofNullable(System.getenv("AUDIT_TOPIC")).orElse("audit");

    void consume(KafkaConsumer<String, String> consumer) {
        consumer.subscribe(List.of("payments"));
        consumer.subscribe(Arrays.asList("invoices", "credits"));
        consumer.subscribe(Collections.singletonList(REFUNDS));
        consumer.subscribe(Pattern.compile("orders-.*"));
        // consumer.subscribe(List.of("commented"));
        String text = "consumer.subscribe(List.of(\"in-text\"))";
        flux.subscribe(v -> log(v));
        mono.subscribe(System.out::println);
    }

    void publish(KafkaProducer<String, String> producer, KafkaTemplate<String, String> kafkaTemplate) {
        producer.send(new ProducerRecord<>("orders", "k", "v"));
        producer.send(new ProducerRecord<String, String>(audit, "v"));
        kafkaTemplate.send("shipments", "v");
        producer.send(new ProducerRecord<>(topicFor("x"), "v"));
    }

    @KafkaListener(topics = "returns")
    void onReturn(String value) {}

    @KafkaListener(topics = {"alpha", "beta"}, groupId = "g")
    void onAlpha(String value) {}

    String topicFor(String x) { return x; }
}
