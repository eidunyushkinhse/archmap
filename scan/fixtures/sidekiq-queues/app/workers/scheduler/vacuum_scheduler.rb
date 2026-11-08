module Scheduler
  class VacuumScheduler
    include Sidekiq::Worker
    sidekiq_options retry: 0, lock: :until_executed
  end
end
