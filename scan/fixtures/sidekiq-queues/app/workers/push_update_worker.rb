class PushUpdateWorker
  include Sidekiq::Worker
  sidekiq_options queue: 'push', retry: 5
end
