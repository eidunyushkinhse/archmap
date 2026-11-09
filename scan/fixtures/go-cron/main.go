package main

import (
	"fmt"
	"time"

	"github.com/robfig/cron/v3"
)

const nightly = "0 3 * * *"

var spec = loadSpec()

func main() {
	c := cron.New()
	c.AddFunc("@every 10m", refresh)
	c.AddFunc(nightly, s.cleanup)
	c.AddFunc(spec, refresh)
	c.AddJob("0 0 * * *", reportJob)
	c.Schedule(cron.Every(time.Hour), reportJob)
	c.AddFunc(fmt.Sprintf("@every %s", interval), func() {
		refresh()
	})
	// c.AddFunc("@hourly", commented)
	c.Start()
}
