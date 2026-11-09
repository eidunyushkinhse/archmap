package joinapi

import "net/http"

func Register(mux *http.ServeMux, root string) {
	// Склейка: путь собран из частей, маршрута «/» нет, есть подсказка.
	mux.Handle("/"+root+"/", files(root))
	// Два литерала: путь склеивается целиком (ТЗ §15 п. 15 К5).
	mux.HandleFunc("/api" + "/v2", v2)
	// Ловушка: обычный литерал рядом остаётся маршрутом.
	http.HandleFunc("/plain", v2)
}
