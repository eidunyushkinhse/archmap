package shop

val topic: String = System.getenv("KAFKA_TOPIC") ?: "orders"
val prefix = "fraud"

fun main() {
    val consumer = KafkaConsumer<String, String>(props).apply {
        subscribe(listOf(topic))
    }
    consumer.subscribe(setOf("alerts"))
    producer.send(ProducerRecord("verdicts", "k", "v"))
    producer.send(ProducerRecord("$prefix-out", "k", "v"))
    consumer.unsubscribe()
}

@KafkaListener(topics = ["kt-events"])
fun onEvent(value: String) {}
