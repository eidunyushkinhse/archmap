package shop;

public class Plain {
    void consume(Consumer consumer) {
        consumer.subscribe(List.of("not-kafka"));
    }
}
