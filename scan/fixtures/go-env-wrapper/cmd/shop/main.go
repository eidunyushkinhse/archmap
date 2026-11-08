package main

import (
	"os"

	"example.com/shop/v2/common"
	"example.com/shop/v2/envutil"
	"example.com/shop/v2/legacy"
	other "github.com/acme/consts"
)

func main() {
	_ = envutil.StringFromEnv("SHOP_REGION", "eu")
	_ = envutil.ParseNumFromEnv("SHOP_WORKERS", 4, 1)
	_ = envutil.StringFromEnv(common.EnvGnuPGHome, common.DefaultHome)
	_ = envutil.ParseNumFromEnv(common.EnvCacheSize, 128, 0)
	_ = os.Getenv(common.EnvGnuPGHome)
	// Ловушки: константа чужого модуля и выражение — подсказки, не параметры.
	_ = envutil.StringFromEnv(other.EnvName, "")
	_ = envutil.StringFromEnv("SHOP_"+os.Args[0], "")
	// Ловушка: то же имя в другом пакете не обёртка.
	_ = legacy.StringFromEnv("NOT_A_PARAM")
	var addr string
	mustMapEnv(&addr, "SHOP_ADDR")
}

func mustMapEnv(target *string, envKey string) {
	v := os.Getenv(envKey)
	if v == "" {
		panic(envKey + " not set")
	}
	*target = v
}
