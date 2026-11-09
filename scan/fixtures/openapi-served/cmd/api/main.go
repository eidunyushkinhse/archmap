package main

import (
	"net/http"

	"example.com/shop/util/swagger"
)

func main() {
	mux := http.NewServeMux()
	swagger.Register(mux)
	http.ListenAndServe(":8080", mux)
}
