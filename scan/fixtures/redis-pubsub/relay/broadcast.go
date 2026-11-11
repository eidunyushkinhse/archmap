package main

import "context"

func broadcast(ctx context.Context, client Broker) {
	client.Subscribe(ctx, "not-redis")
}
