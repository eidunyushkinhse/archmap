package main

import "net/http"

func main() {
	http.HandleFunc("/health", health)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items/{id}", item)
	mux.Handle("/static/", files)
	// http.HandleFunc("/commented", health) — строка в комментарии маршрутом не считается.
	_ = http.ListenAndServe(":8080", mux)
}
