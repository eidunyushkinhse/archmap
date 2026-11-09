use envconfig::Envconfig;

#[derive(Envconfig)]
pub struct Empty {}

#[derive(Envconfig, Clone)]
pub struct Config {
    #[envconfig(from = "KAFKA_HOSTS", default = "kafka:9092")]
    pub kafka_hosts: String,

    #[envconfig(default = "3000")]
    pub port: u16,

    /// Адрес кэша: без него кэш выключен.
    #[envconfig(from = "REDIS_URL")]
    #[serde(default)]
    pub redis_url: Option<String>,

    #[envconfig(from = "DATABASE_URL")]
    pub database_url: String,

    // Поле без атрибута: имя в верхнем регистре (ТЗ §15 п. 16 Р3).
    pub output_kafka_hosts: String,

    pub batch_size: Option<u32>,

    /// Документация поля
    #[serde(rename = "flush")]
    pub flush_interval: std::time::Duration,

    #[envconfig(nested = true)]
    pub outputs: Outputs,
}

// Без derive(Envconfig): поля не параметры.
#[derive(Clone, Debug)]
pub struct Outputs {
    pub topic: String,
    pub handler: fn(u8) -> Result<(), String>,
}
