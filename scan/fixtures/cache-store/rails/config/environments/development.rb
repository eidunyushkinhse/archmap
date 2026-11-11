Rails.application.configure do
  config.cache_store = :redis_cache_store, { url: "redis://localhost:6379/9" }
end
