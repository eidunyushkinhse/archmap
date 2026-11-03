package main

import (
	"github.com/IBM/sarama"
	"github.com/segmentio/kafka-go"
)

func run() {
	w := &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "orders.created"}
	r := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, Topic: "payments", GroupID: "g"})
	msg := &sarama.ProducerMessage{Topic: "audit", Value: sarama.StringEncoder("x")}
	pc, _ := consumer.ConsumePartition("refunds", 0, sarama.OffsetNewest)
	_ = group.Consume(ctx, []string{"payments", "refunds"}, handler)
	_, _, _, _ = w, r, msg, pc
}
