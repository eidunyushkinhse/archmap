package main

import "os"

type Config struct {
	Port    int    `env:"PORT" envDefault:"8080"`
	DB      string `env:"DATABASE_URL,required"`
	Timeout string `env:"TIMEOUT, default=30s"`
	Name    string `json:"name"`
}

func main() {
	_ = os.Getenv("LOG_LEVEL")
	if v, ok := os.LookupEnv("REGION"); ok {
		_ = v
	}
	key := "X"
	_ = os.Getenv(key)
	// os.Getenv("COMMENTED") — строка в комментарии параметром не считается.
}

func otel(name string) string {
	// Склейка: литерал лишь часть имени, параметра «OTEL_EXPORTER_OTLP_» нет, есть подсказка.
	_ = os.Getenv("OTEL_EXPORTER_OTLP_" + name)
	// Ловушка: обычный литерал рядом остаётся параметром.
	return os.Getenv("OTEL_SERVICE_NAME")
}
