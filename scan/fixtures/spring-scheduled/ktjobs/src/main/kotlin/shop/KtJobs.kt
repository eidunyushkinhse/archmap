package shop

import org.springframework.scheduling.annotation.Scheduled

class KtJobs {
    @Scheduled(cron = "0 */5 * * * *")
    fun every5() {
    }

    @Scheduled(fixedDelayString = "\${kt.delay:PT10S}")
    fun delayed() {
    }

    @Scheduled(cron = CRON)
    fun fromConst() {
    }

    @Scheduled(fixedRate = 2, timeUnit = TimeUnit.HOURS)
    fun twoHours() {
    }
}

const val CRON = "0 0 2 * * *"
