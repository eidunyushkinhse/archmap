package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

func main() {
	ctx := context.Background()
	rdb := redis.NewClient(&redis.Options{Addr: "cache:6379"})
	rdb.Publish(ctx, revokedKey, "id")
	sub := rdb.Subscribe(ctx, "relay:events", "relay:audit")
	_ = sub
	rdb.PSubscribe(ctx, "relay:*")
	key := "x"
	rdb.Publish(ctx, key, "")
}
