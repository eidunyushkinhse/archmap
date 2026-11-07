class ApplicationWorker
  include Sidekiq::Worker
  sidekiq_options queue: 'ingress'
end

class InboxWorker < ApplicationWorker
end

class DynamicWorker
  include Sidekiq::Worker
  sidekiq_options queue: QUEUE_NAME
end
