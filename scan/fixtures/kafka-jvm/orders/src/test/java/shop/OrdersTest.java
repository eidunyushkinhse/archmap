package shop;

class OrdersTest {
    void t(KafkaConsumer<String, String> consumer) {
        consumer.subscribe(List.of("test-topic"));
    }
}
