package ginapi

import "github.com/gin-gonic/gin"

func Setup() *gin.Engine {
	r := gin.Default()
	r.GET("/ping", ping)
	v1 := r.Group("/v1")
	v1.POST("/orders", create)
	admin := v1.Group("/admin")
	admin.DELETE("/cache", drop)
	r.Handle("PATCH", "/legacy", legacy)
	r.GET(pathVar, ping)
	resp, _ := client.Get("/api/remote") // вызов клиента, а не маршрут
	_ = resp
	return r
}

// Register получает группу параметром: где она подключена, отсюда не видно.
func Register(g *gin.RouterGroup) {
	g.GET("/plugin", ping)
}
