package main

import "example.com/shop/events"

// Своя шина событий: Publish и Subscribe здесь не NATS.
func wire(bus *events.Bus, ctx context.Context) {
	bus.Publish("not-nats", nil)
	bus.Subscribe(ctx, "not-nats.either")
}
