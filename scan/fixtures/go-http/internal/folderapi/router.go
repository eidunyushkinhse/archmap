package folderapi

import "github.com/go-chi/chi/v5"

func Routes() chi.Router {
	r := chi.NewRouter()
	r.Route("/api", func(api chi.Router) {
		registerFolders(api)
	})
	// Та же функция регистрации подключена второй раз под другим префиксом.
	r.Route("/internal", func(internal chi.Router) {
		registerFolders(internal)
	})
	return r
}
