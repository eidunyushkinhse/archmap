Rails.application.configure do
  config.eager_load = true
  # config.cache_store = :mem_cache_store
  config.cache_store = :redis_cache_store, { url: ENV.fetch("REDIS_URL") }
end
