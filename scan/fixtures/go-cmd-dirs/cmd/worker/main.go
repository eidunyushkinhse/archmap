package main

import "os"

func main() {
	_ = os.Getenv("WORKER_QUEUE")
}
