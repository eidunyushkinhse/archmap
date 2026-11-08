// Ловушка: программа без контейнера в манифестах, её код не общий.
package main

import "os"

func main() {
	_ = os.Getenv("MIGRATE_DSN")
}
