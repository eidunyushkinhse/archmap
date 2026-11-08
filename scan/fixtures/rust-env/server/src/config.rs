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

    #[envconfig(nested = true)]
    pub outputs: Outputs,
}
