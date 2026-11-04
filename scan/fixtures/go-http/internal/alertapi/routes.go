package alertapi

import (
	"strings"

	"github.com/go-chi/chi/v5"
)

// toPath переводит {id} в синтаксис маршрутизатора, как toMacaronPath у Grafana.
func toPath(path string) string {
	return strings.ReplaceAll(path, "{", ":")
}

func Routes() chi.Router {
	r := chi.NewRouter()
	r.Route("/v1", func(group chi.Router) {
		group.Get(
			toPath("/alerts/{id}"),
			getAlert,
		)
		group.Delete(toPath( "/alerts/{id}" ), deleteAlert)
	})
	return r
}
