package envutil

import (
	"os"
	"strconv"
)

// StringFromEnv — обёртка чтения: параметр key целиком уходит в os.Getenv.
func StringFromEnv(key, defaultValue string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultValue
}

// ParseNumFromEnv — обёртка с LookupEnv и числовым дефолтом.
func ParseNumFromEnv(env string, defaultValue, minimum int) int {
	str, ok := os.LookupEnv(env)
	if !ok {
		return defaultValue
	}
	n, _ := strconv.Atoi(str)
	return max(n, minimum)
}

// Ловушка: литерал внутри функции, это не обёртка, а обычное чтение PORT.
func Port() string {
	return os.Getenv("PORT")
}
