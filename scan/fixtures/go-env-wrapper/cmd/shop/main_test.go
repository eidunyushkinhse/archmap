package main

import (
	"os"
	"testing"
)

// Ловушка: тестовый файл не читается, его обёртка и её вызов параметров не дают.
func Getenv(key string) string {
	return os.Getenv(key)
}

func TestGetenv(t *testing.T) {
	_ = Getenv("SHOP_TEST_ONLY")
}
