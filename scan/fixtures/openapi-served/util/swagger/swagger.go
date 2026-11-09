package swagger

import "net/http"

// Register отдаёт описание API.
func Register(mux *http.ServeMux) {
	mux.HandleFunc("/swagger.json", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "assets/swagger.json")
	})
}
