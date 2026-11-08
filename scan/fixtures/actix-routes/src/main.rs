use actix_web::{get, post, web, App, HttpServer};

const ADMIN: &str = "/admin";

#[get("/health")]
async fn health() -> &'static str {
    "ok"
}

#[actix_web::route("/multi", method = "GET", method = "HEAD")]
async fn multi() -> &'static str {
    "ok"
}

// .route("/commented", web::get().to(a))
fn config(cfg: &mut web::ServiceConfig) {
    cfg.route("/nodeinfo", web::get().to(c))
        .route(".well-known/webfinger", web::get().to(c));
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let version = "v3";
    HttpServer::new(|| {
        App::new()
            .service(health)
            .service(
                web::scope("/api/v3")
                    .service(
                        web::scope("/post")
                            .route("", web::get().to(a))
                            .route("/list", web::post().to(b)),
                    )
                    .route("/icon", web::get().to(c)),
            )
            .service(
                web::resource("/x")
                    .route(web::get().to(a))
                    .route(web::delete().to(b)),
            )
            .service(web::resource("/any").to(a))
            .service(web::scope(ADMIN).route("/users", web::put().to(a)))
            .route(&format!("/{}/dynamic", version), web::get().to(a))
            .service(web::scope(version).route("/unresolved", web::get().to(a)))
            .route("/text", web::method(Method::GET).to(a))
            .configure(config)
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[actix_web::test]
    async fn routes() {
        let app = App::new().route("/from-test", web::get().to(a));
    }
}
