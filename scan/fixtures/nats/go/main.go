package main

import "github.com/nats-io/nats.go"

func run(subj string, data []byte) {
	nc, _ := nats.Connect("nats://nats:4222")
	nc.Subscribe("updates", func(m *nats.Msg) {})
	nc.QueueSubscribe("jobs", "workers", func(m *nats.Msg) {})
	nc.Publish("jobs.done", []byte("x"))
	nc.Publish(subj, data)
}
