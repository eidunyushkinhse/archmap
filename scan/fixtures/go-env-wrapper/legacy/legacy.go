package legacy

// Ловушка: то же имя, что у обёртки envutil, но окружение не читает.
func StringFromEnv(prefix string) string {
	return prefix + "-legacy"
}
