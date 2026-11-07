// Закоммиченный каталог coverage/ — код (pkg/util/coverage/ Kubernetes), а не вывод покрытия.
package coverage

import "os"

func File() string {
	return os.Getenv("PROXY_COVERAGE_FILE")
}
