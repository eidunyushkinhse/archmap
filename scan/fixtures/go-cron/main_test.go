package main

import (
	"testing"

	"github.com/robfig/cron/v3"
)

func TestCron(t *testing.T) {
	c := cron.New()
	c.AddFunc("@every 1s", refresh)
}
