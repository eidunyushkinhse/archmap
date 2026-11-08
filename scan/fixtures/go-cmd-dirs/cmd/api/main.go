package main

import (
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("API_PORT")
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {})
	_ = http.ListenAndServe(":"+port, nil)
}
