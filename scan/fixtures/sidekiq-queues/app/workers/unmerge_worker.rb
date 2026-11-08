class UnmergeWorker
  include Sidekiq::Job
  sidekiq_options queue: :pull
end
