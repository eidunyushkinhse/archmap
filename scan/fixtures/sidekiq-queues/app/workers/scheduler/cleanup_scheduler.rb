module Scheduler
  class CleanupScheduler
    include Sidekiq::Worker
    sidekiq_options retry: 0
  end
end
