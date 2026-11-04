package folderapi

import "github.com/go-chi/chi/v5"

func registerFolders(r chi.Router) {
	r.Get("/folders", listFolders)
	r.Route("/folders/{uid}", func(folder chi.Router) {
		folder.Delete("/", deleteFolder)
	})
}

// registerArchive никто не вызывает: где подключена группа, отсюда не видно.
func registerArchive(r chi.Router) {
	r.Get("/archive", listArchive)
}
