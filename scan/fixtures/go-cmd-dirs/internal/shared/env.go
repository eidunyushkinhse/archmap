// Общий код вне cmd/: его параметры у обоих контейнеров.
package shared

import "os"

var LogLevel = os.Getenv("SHARED_LOG_LEVEL")
