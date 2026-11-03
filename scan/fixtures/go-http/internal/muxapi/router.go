package muxapi

import "github.com/gorilla/mux"

func Routes() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/products", list).Methods("GET", "POST")
	s := r.PathPrefix("/admin").Subrouter()
	s.HandleFunc("/stats", stats).Methods("GET")
	return r
}
