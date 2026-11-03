package chiapi

import "github.com/go-chi/chi/v5"

func Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", index)
	r.Route("/api", func(r chi.Router) {
		r.Post("/users", createUser)
		r.Route("/v2", func(r chi.Router) {
			r.Delete("/users/{id}", deleteUser)
		})
	})
	return r
}
