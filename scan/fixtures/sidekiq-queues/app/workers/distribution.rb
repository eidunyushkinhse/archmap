# Ловушка: одноимённые классы разных модулей, наследник берёт очередь своего базового.
class DistributionWorker
  include Sidekiq::Worker
end

class ActivityPub::RawDistributionWorker
  include Sidekiq::Worker
  sidekiq_options queue: 'push'
end

class ActivityPub::DistributionWorker < ActivityPub::RawDistributionWorker
end

class ActivityPub::StatusUpdateDistributionWorker < ActivityPub::DistributionWorker
end
