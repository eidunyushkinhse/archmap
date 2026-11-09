package clientapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Запросы клиентов рядом с регистрациями: маршрутами становятся только регистрации.
func Run(url string, api *Client) {
	r := chi.NewRouter()
	r.Get("/a", a)
	http.HandleFunc("/b", b)
	resp, _ := http.Get("http://x/health")
	_, _ = http.Get(url)
	_, _ = http.Post(url, "application/json", nil)
	_, _ = client.Get(url)
	_, _ = api.Get(url)
	_, _ = r.Get(url)
	_, _ = r.GET(urlFor("/c"))
	_ = resp
	// go-restful: построитель маршрута, обработчик в цепочке после скобки.
	ws.Route(ws.GET("/logs").
		To(logs))
}
