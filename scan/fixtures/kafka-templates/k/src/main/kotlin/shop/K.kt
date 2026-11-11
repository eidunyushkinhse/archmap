package shop

class K(private val eventsTemplate: KafkaTemplate<String, String>) {
  fun declared() { eventsTemplate.send("kotlin-declared", "v") }
  fun rabbit() { rabbitTemplate.send("kotlin-exchange", "v") }
}
