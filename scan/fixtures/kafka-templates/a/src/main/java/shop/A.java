package shop;

class A {
  private final KafkaTemplate<String, String> template;

  void declared() { template.send("declared", "v"); }
  void named() { kafkaTemplate.send("named", "v"); }
  void namedToo() { myKafkaTemplate.send("named-too", "v"); }
  void data() { kafkaTemplate.sendDefault("data"); }
  void rabbit() { rabbitTemplate.send("exchange", "v"); }
  void jms() { jmsTemplate.send("queue", "v"); }
  void other() { otherTemplate.send("unknown", "v"); }
}
