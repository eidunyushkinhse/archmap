package joinapi

import "net/http"

func Register(mux *http.ServeMux, root string) {
	// Склейка: путь собран из частей, маршрута «/» нет, есть подсказка.
	mux.Handle("/"+root+"/", files(root))
	// Два литерала тоже склейка: путь целиком сборщик не собирает.
	mux.HandleFunc("/api" + "/v2", v2)
	// Ловушка: обычный литерал рядом остаётся маршрутом.
	http.HandleFunc("/plain", v2)
}
