package org.example.kt

import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "kt")
data class KtProps(val heapSize: Int = 100, val name: String, val cache: Cache) {
    data class Cache(val ttl: Long = 60)
}

class KtService(@Value("\${kt.port:8080}") private val port: Int) {
    @Value("\${kt.flag}")
    lateinit var flag: String

    @field:Value("\${kt.field:x}")
    var field: String = ""

    @Value("\${kt.\$name}")
    var templated: String = ""
}

@ConfigurationProperties("kt.vars")
class KtVars {
    var size: Int = 5
    val fixed: Int = 1
    fun f() {
        var local: Int = 3
    }
}
