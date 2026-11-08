use clap::Parser;

#[derive(Parser)]
struct Cli {
    #[arg(long, default_value_t = false, env = "DISABLE_HTTP")]
    disable_http: bool,
    #[arg(long, env, default_value = "info")]
    log_level: String,
}

fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn main() {
    let path = std::env::var("CONFIG_PATH").unwrap_or_else(|_| "config.hjson".to_string());
    let url = env::var("SERVICE_URL").expect("нужен адрес");
    let name = String::from("X");
    let dynamic = std::env::var(&name);
    let ci = option_env!("CI_PIPELINE");
    // std::env::var("COMMENTED")
}

#[cfg(test)]
mod tests {
    #[test]
    fn t() {
        std::env::var("TEST_ONLY").ok();
    }
}
