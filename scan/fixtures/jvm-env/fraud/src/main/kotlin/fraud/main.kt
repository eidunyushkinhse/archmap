package fraud

// Элвис с литералом: дефолт (как KAFKA_TOPIC у OpenTelemetry Demo).
val topic: String = System.getenv("KAFKA_TOPIC") ?: "orders"
const val GROUP = "fraud"
const val NAME_ENV = "FRAUD_NAME"

fun main() {
    val servers = System.getenv("KAFKA_ADDR")
    val port = System.getenv("FRAUD_PORT")?.toInt() ?: 8080
    val debug = System.getenv("FRAUD_DEBUG").toBoolean()
    val ratio = (System.getenv("FRAUD_RATIO") ?: "0.5").toDouble()
    val level = System.getenv("FRAUD_LEVEL")?.lowercase()
    val home = System.getenv("FRAUD_HOME") ?: error("FRAUD_HOME is required")
    val strict = System.getenv("FRAUD_STRICT") ?: throw IllegalStateException("no")
    val mode = System.getenv("FRAUD_MODE") ?: defaultMode()
    val tmpl = System.getenv("FRAUD_TMPL") ?: "${GROUP}-x"
    val next = System.getenv("FRAUD_NEXT")
        ?: "n"
    val byConst = System.getenv(NAME_ENV)
    val map = System.getenv().getOrDefault("FRAUD_MAP", "m")
    val prop = System.getProperty("fraud.prop")
    // System.getenv("COMMENTED")
    val s = "System.getenv(\"IN_STRING\")"
    /* System.getenv("BLOCK") /* вложенный */ System.getenv("STILL_COMMENT") */
}

fun defaultMode(): String = "batch"
